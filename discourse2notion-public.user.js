// ==UserScript==
// @name         Discourse 帖子导出到 Notion / 文稿
// @namespace    https://discourse.org/
// @version      4.6.2-public
// @description  导出 Discourse 社区帖子到 Notion 或 Markdown（保留原生块与 Markdown 格式）
// @author       ilvsx
// @license      MIT
// @match        https://*/t/*
// @match        https://*/t/topic/*
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_download
// @grant        GM_xmlhttpRequest
// @connect      api.notion.com
// @run-at       document-idle
// ==/UserScript==

(function () {
    "use strict";

    // -----------------------
    // 存储 key
    // -----------------------
    const K = {
        EXPORT_TEMPLATE: "ld_export_template",
        // 筛选相关
        RANGE_MODE: "ld_export_range_mode",
        RANGE_START: "ld_export_range_start",
        RANGE_END: "ld_export_range_end",
        FILTER_ONLY_OP: "ld_export_filter_only_op",
        FILTER_IMG: "ld_export_filter_img",
        FILTER_USERS: "ld_export_filter_users",
        FILTER_INCLUDE: "ld_export_filter_include",
        FILTER_EXCLUDE: "ld_export_filter_exclude",
        FILTER_MINLEN: "ld_export_filter_minlen",
        AI_FILTER_ENABLED: "ld_export_ai_filter_enabled",
        AI_API_URL: "ld_export_ai_api_url",
        AI_API_KEY: "ld_export_ai_api_key",
        AI_MODEL_ID: "ld_export_ai_model_id",
        // UI 状态
        PANEL_COLLAPSED: "ld_export_panel_collapsed",
        BUBBLE_Y: "ld_export_bubble_y",
        EXPORT_STYLE_OPEN: "ld_export_style_panel_open",
        NOTION_API_KEY: "ld_export_notion_api_key",
        NOTION_PARENT_PAGE_ID: "ld_export_notion_parent_page_id",
        NOTION_DATABASE_ID: "ld_export_notion_database_id",
        NOTION_PANEL_OPEN: "ld_export_notion_panel_open",
        INCLUDE_REPLIES: "ld_export_include_replies",
    };

    const DEFAULTS = {
        exportTemplate: "forum",
        rangeMode: "all",
        rangeStart: 1,
        rangeEnd: 999999,
        onlyOp: false,
        imgFilter: "none",
        users: "",
        include: "",
        exclude: "",
        minLen: 0,
        aiEnabled: false,
        aiApiUrl: "",
        aiApiKey: "",
        aiModelId: "",
        notionApiKey: "",
        notionParentPageId: "",
        notionDatabaseId: "",
        includeReplies: false,
    };
    function normalizeNotionId(value) {
        return String(value || "").trim().replace(/-/g, "");
    }

    function buildNotionHeaders(apiKey, extra = {}) {
        return {
            Authorization: `Bearer ${apiKey}`,
            "Notion-Version": "2022-06-28",
            "Content-Type": "application/json",
            ...extra,
        };
    }

    function notionRequest(path, init = {}, apiKey) {
        const normalizedApiKey = String(apiKey || "").trim();
        if (!normalizedApiKey) return Promise.reject(new Error("请先配置 Notion API Key"));

        const headers = buildNotionHeaders(normalizedApiKey, init.headers || {});
        if (headers["Content-Type"] === undefined) delete headers["Content-Type"];

        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: init.method || "GET",
                url: `https://api.notion.com/v1${path}`,
                headers,
                data: init.body,
                onload: (response) => {
                    const status = response.status || 0;
                    const text = response.responseText || "";
                    let data = null;
                    try {
                        data = text ? JSON.parse(text) : null;
                    } catch (_) {}

                    if (status >= 200 && status < 300) {
                        resolve(data);
                        return;
                    }

                    const detail = data?.message || data?.code || text || `HTTP ${status}`;
                    reject(new Error(`HTTP ${status}: ${detail}`));
                },
                onerror: (error) => {
                    const detail = error?.error || error?.details || error?.message || "load failed";
                    reject(new Error(`请求 Notion 失败: ${detail}`));
                },
                ontimeout: () => reject(new Error("请求 Notion 超时")),
            });
        });
    }

    async function requestNotion(path, init = {}, apiKey) {
        return notionRequest(path, init, apiKey);
    }

    function chunkRichTextContent(text, limit = 1800) {
        const source = String(text || "");
        if (!source) return [];
        const chunks = [];
        for (let start = 0; start < source.length; start += limit) {
            chunks.push(source.slice(start, start + limit));
        }
        return chunks;
    }

    function buildNotionRichTextItem(content, annotations = {}, link = "") {
        return {
            type: "text",
            text: {
                content: String(content || "").slice(0, 2000),
                ...(link ? { link: { url: link } } : {}),
            },
            annotations: {
                bold: !!annotations.bold,
                italic: !!annotations.italic,
                strikethrough: !!annotations.strikethrough,
                underline: !!annotations.underline,
                code: !!annotations.code,
                color: annotations.color || "default",
            },
        };
    }

    function buildRichTextArrayFromText(text, annotations = {}, limit = 1800) {
        return chunkRichTextContent(String(text || ""), limit)
            .filter(Boolean)
            .map((chunk) => buildNotionRichTextItem(chunk, annotations));
    }

    function buildNotionRichTextWithLinksFromHtml(html, limit = 1800) {
        const source = String(html || "");
        if (!source.trim()) return [];

        const pieces = [];
        const pattern = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
        let lastIndex = 0;
        let match;

        const pushPlain = (fragment) => {
            const text = htmlToPlainText(fragment);
            if (!text) return;
            chunkRichTextContent(text, limit).forEach((chunk) => {
                if (chunk) pieces.push(buildNotionRichTextItem(chunk));
            });
        };

        while ((match = pattern.exec(source))) {
            if (match.index > lastIndex) {
                pushPlain(source.slice(lastIndex, match.index));
            }
            const url = sanitizeExternalUrl(match[1]);
            const text = stripHtmlTags(match[2]) || url;
            if (text) {
                chunkRichTextContent(text, limit).forEach((chunk) => {
                    if (chunk) pieces.push(buildNotionRichTextItem(chunk, {}, url || ""));
                });
            }
            lastIndex = pattern.lastIndex;
        }

        if (lastIndex < source.length) {
            pushPlain(source.slice(lastIndex));
        }

        return pieces.filter(Boolean);
    }

    function buildNotionParagraphBlock(text, annotations = {}) {
        const richText = buildRichTextArrayFromText(String(text || "").trim(), annotations);
        return {
            object: "block",
            type: "paragraph",
            paragraph: {
                rich_text: richText,
            },
        };
    }

    function buildNotionParagraphBlockFromHtml(html) {
        const cleaned = String(html || "")
            .replace(/<img[^>]*>/gi, " ")
            .replace(/\bimage\d+×\d+\s+[\d.]+\s*(?:KB|MB|GB)\b/gi, " ")
            .replace(/\bimage\d+[x×]\d+\s+[\d.]+\s*(?:KB|MB|GB)\b/gi, " ");
        const richText = buildNotionRichTextWithLinksFromHtml(cleaned);
        if (!richText.length) return null;
        return {
            object: "block",
            type: "paragraph",
            paragraph: {
                rich_text: richText,
            },
        };
    }

    function buildNotionBookmarkBlock(url, caption = "") {
        const src = String(url || "").trim();
        if (!src) return null;
        return {
            object: "block",
            type: "bookmark",
            bookmark: {
                url: src,
                caption: caption ? buildRichTextArrayFromText(caption) : [],
            },
        };
    }

    function buildNotionHeadingBlock(level, text) {
        const type = level === 1 ? "heading_1" : level === 2 ? "heading_2" : "heading_3";
        return {
            object: "block",
            type,
            [type]: {
                rich_text: buildRichTextArrayFromText(String(text || "").trim()),
            },
        };
    }

    function buildNotionQuoteBlock(text) {
        return {
            object: "block",
            type: "quote",
            quote: {
                rich_text: buildRichTextArrayFromText(String(text || "").trim()),
            },
        };
    }

    function buildNotionBulletedListItemBlock(text) {
        return {
            object: "block",
            type: "bulleted_list_item",
            bulleted_list_item: {
                rich_text: buildRichTextArrayFromText(String(text || "").trim()),
            },
        };
    }

    function buildNotionNumberedListItemBlock(text) {
        return {
            object: "block",
            type: "numbered_list_item",
            numbered_list_item: {
                rich_text: buildRichTextArrayFromText(String(text || "").trim()),
            },
        };
    }

    function buildNotionCodeBlock(lines, language = "plain text") {
        const text = Array.isArray(lines) ? lines.join("\n") : String(lines || "");
        return {
            object: "block",
            type: "code",
            code: {
                language: String(language || "plain text").trim() || "plain text",
                rich_text: buildRichTextArrayFromText(text, {}, 1500),
            },
        };
    }

    function buildNotionCalloutBlock(text, emoji = "💬") {
        return {
            object: "block",
            type: "callout",
            callout: {
                icon: { type: "emoji", emoji },
                rich_text: buildRichTextArrayFromText(String(text || "").trim()),
            },
        };
    }

    function sanitizeExternalUrl(url) {
        const value = String(url || "").trim();
        if (!value) return "";
        try {
            if (/^\/\//.test(value)) {
                return `${location.protocol}${value}`;
            }
            if (/^https?:\/\//i.test(value)) {
                return value;
            }
            const parsed = new URL(value, location.origin);
            if (!/^https?:$/i.test(parsed.protocol)) return "";
            return parsed.href;
        } catch (_) {
            return "";
        }
    }

    function normalizeImageUrl(url) {
        const src = sanitizeExternalUrl(url);
        if (!src) return "";
        try {
            const parsed = new URL(src);
            const original = parsed.searchParams.get("url") || parsed.searchParams.get("orig") || parsed.searchParams.get("original");
            if (original) {
                const nested = sanitizeExternalUrl(original);
                if (nested) return nested;
            }
            parsed.hash = "";
            return parsed.href;
        } catch (_) {
            return src;
        }
    }

    function buildNotionImageBlock(url) {
        const src = sanitizeExternalUrl(url);
        if (!src) return null;
        return {
            object: "block",
            type: "image",
            image: {
                type: "external",
                external: { url: src },
            },
        };
    }

    function decodeHtmlEntities(text) {
        return String(text || "")
            .replace(/&nbsp;/g, " ")
            .replace(/&amp;/g, "&")
            .replace(/&lt;/g, "<")
            .replace(/&gt;/g, ">")
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&#x27;/gi, "'");
    }

    function stripHtmlTags(html) {
        return decodeHtmlEntities(String(html || "").replace(/<[^>]+>/g, "")).trim();
    }

    function htmlToPlainText(html) {
        return decodeHtmlEntities(String(html || "")
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>|<\/div>|<\/li>|<\/blockquote>|<\/pre>|<\/h[1-6]>/gi, "\n")
            .replace(/<[^>]+>/g, "")
            .replace(/\bimage\d+[x×]\d+\s+[\d.]+\s*(?:KB|MB|GB)\b/gi, " ")
            .replace(/\n{3,}/g, "\n\n")
            .trim());
    }

    function extractImageUrlsFromHtml(html) {
        const source = String(html || "");
        const urls = [];
        const pushUrl = (value) => {
            const normalized = normalizeImageUrl(value);
            if (normalized && !urls.includes(normalized)) urls.push(normalized);
        };
        const anchorMatches = [...source.matchAll(/<a([^>]+)href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        anchorMatches.forEach((item) => {
            const attrs = String(item[1] || "");
            const inner = String(item[3] || "");
            const hasImageChild = /<(img|picture|source)\b/i.test(inner);
            const isAttachmentOnly = /class=["'][^"']*\battachment\b[^"']*["']/i.test(attrs) && !hasImageChild;
            if (isAttachmentOnly) return;
            const isLightboxLike = /class=["'][^"']*(?:lightbox|img-download-btn)[^"']*["']/i.test(attrs);
            if (hasImageChild || isLightboxLike) {
                return;
            }
        });

        const imgTagMatches = [...source.matchAll(/<img\b[^>]*>/gi)];
        imgTagMatches.forEach((item) => {
            const tag = String(item[0] || "");
            const originalCandidates = [...tag.matchAll(/(?:data-orig-src|data-original-src)=["']([^"']+)["']/gi)].map((m) => m[1]);
            const fallbackCandidates = [...tag.matchAll(/(?:src|data-src)=["']([^"']+)["']/gi)].map((m) => m[1]);
            const chosen = originalCandidates.find(Boolean) || fallbackCandidates.find(Boolean);
            if (chosen) pushUrl(chosen);
        });

        return urls;
    }

    function extractLinkItemsFromHtml(html) {
        const matches = [...String(html || "").matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)];
        return matches
            .map((item) => {
                const rawText = String(item[2] || "");
                const text = stripHtmlTags(rawText);
                return {
                    url: sanitizeExternalUrl(item[1]),
                    text,
                    rawText,
                    isImageOnly: !text && /<(img|picture|source)\b/i.test(rawText),
                };
            })
            .filter((item) => item.url)
            .filter((item) => !/(?:lightbox|image-wrapper|magnific-popup|thumbnail)/i.test(item.rawText));
    }

    function extractCodeBlocksFromHtml(html) {
        const matches = [...String(html || "").matchAll(/<pre[^>]*><code([^>]*)>([\s\S]*?)<\/code><\/pre>/gi)];
        return matches.map((item) => {
            const attrs = item[1] || "";
            const lang = attrs.match(/class=["'][^"']*lang(?:uage)?-([^\s"']+)/i)?.[1] || attrs.match(/data-code-lang=["']([^"']+)["']/i)?.[1] || "plain text";
            return {
                language: String(lang || "plain text").trim() || "plain text",
                code: decodeHtmlEntities(item[2]).trim(),
            };
        }).filter((item) => item.code);
    }

    function extractBlockquotesFromHtml(html) {
        const matches = [...String(html || "").matchAll(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi)];
        return matches.map((item) => htmlToPlainText(item[1])).filter(Boolean);
    }

    function extractHeadingsFromHtml(html) {
        const matches = [...String(html || "").matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)];
        return matches
            .map((item) => ({ level: Number(item[1]) || 2, text: stripHtmlTags(item[2]) }))
            .filter((item) => item.text);
    }

    function extractListItemsFromHtml(html, ordered = false) {
        const tag = ordered ? "ol" : "ul";
        const listMatches = [...String(html || "").matchAll(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "gi"))];
        const items = [];
        for (const listMatch of listMatches) {
            const liMatches = [...String(listMatch[1] || "").matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)];
            for (const li of liMatches) {
                const text = htmlToPlainText(li[1]);
                if (text) items.push(text);
            }
        }
        return items;
    }

    function markdownToNotionBlocks(markdown) {
        const lines = String(markdown || "").replace(/\r\n/g, "\n").split("\n");
        const blocks = [];
        let codeBuffer = [];
        let inCode = false;

        const flushCode = () => {
            if (!codeBuffer.length) return;
            blocks.push(buildNotionCodeBlock(codeBuffer));
            codeBuffer = [];
        };

        for (const rawLine of lines) {
            const line = rawLine.replace(/\t/g, "    ");
            const trimmed = line.trim();

            if (trimmed.startsWith("```")) {
                if (inCode) {
                    flushCode();
                    inCode = false;
                } else {
                    inCode = true;
                }
                continue;
            }

            if (inCode) {
                codeBuffer.push(rawLine);
                continue;
            }

            if (!trimmed) {
                continue;
            }

            if (/^#{1,3}\s+/.test(trimmed)) {
                const level = trimmed.match(/^#+/)[0].length;
                blocks.push(buildNotionHeadingBlock(level, trimmed.replace(/^#{1,3}\s+/, "")));
                continue;
            }

            if (/^>\s+/.test(trimmed)) {
                blocks.push(buildNotionQuoteBlock(trimmed.replace(/^>\s+/, "")));
                continue;
            }

            if (/^[-*]\s+/.test(trimmed)) {
                blocks.push(buildNotionBulletedListItemBlock(trimmed.replace(/^[-*]\s+/, "")));
                continue;
            }

            if (/^\d+\.\s+/.test(trimmed)) {
                blocks.push(buildNotionNumberedListItemBlock(trimmed.replace(/^\d+\.\s+/, "")));
                continue;
            }

            if (/^---+$/.test(trimmed) || /^___+$/.test(trimmed) || /^\*\*\*+$/.test(trimmed)) {
                blocks.push({ object: "block", type: "divider", divider: {} });
                continue;
            }

            blocks.push(buildNotionParagraphBlock(trimmed));
        }

        if (inCode) flushCode();
        return blocks.filter(Boolean);
    }

    function extractStandaloneParagraphsFromHtml(html) {
        const source = String(html || "");
        const sanitized = source
            .replace(/<pre[^>]*>[\s\S]*?<\/pre>/gi, "")
            .replace(/<blockquote[^>]*>[\s\S]*?<\/blockquote>/gi, "")
            .replace(/<ul[^>]*>[\s\S]*?<\/ul>/gi, "")
            .replace(/<ol[^>]*>[\s\S]*?<\/ol>/gi, "")
            .replace(/<h[1-3][^>]*>[\s\S]*?<\/h[1-3]>/gi, "")
            .replace(/<img[^>]*>/gi, "")
            .replace(/<figure[^>]*>[\s\S]*?<\/figure>/gi, "");

        const paragraphMatches = [...sanitized.matchAll(/<(p|div)[^>]*>([\s\S]*?)<\/\1>/gi)];
        const paragraphs = paragraphMatches
            .map((item) => htmlToPlainText(item[2]))
            .map((text) => text.replace(/^[-*]\s+/, "").trim())
            .filter(Boolean);

        if (paragraphs.length) return paragraphs;
        const fallback = htmlToPlainText(sanitized);
        return fallback ? fallback.split(/\n{2,}/).map((text) => text.trim()).filter(Boolean) : [];
    }

    function splitHtmlIntoTopLevelSegments(html) {
        const source = String(html || "").trim();
        if (!source) return [];

        const segments = [];
        const foundImages = new Set();
        const pushImageSegment = (url) => {
            const normalized = normalizeImageUrl(url);
            if (!normalized || foundImages.has(normalized)) return;
            foundImages.add(normalized);
            segments.push({ type: "image", url: normalized });
        };
        const pushFragment = (fragment, tagName = "") => {
            const tag = String(tagName || "").toLowerCase();
            if (tag === "h1" || tag === "h2" || tag === "h3") {
                const text = stripHtmlTags(fragment);
                if (text) segments.push({ type: "heading", level: Number(tag[1]), text });
                return;
            }
            if (tag === "blockquote" || tag === "aside") {
                const images = extractImageUrlsFromHtml(fragment);
                images.forEach((url) => pushImageSegment(url));
                const quoteBlock = buildNotionParagraphBlockFromHtml(fragment);
                if (quoteBlock) {
                    segments.push({ type: "quote_html", block: {
                        object: "block",
                        type: "quote",
                        quote: {
                            rich_text: quoteBlock.paragraph.rich_text,
                        },
                    } });
                } else {
                    const text = htmlToPlainText(fragment).trim();
                    if (text) segments.push({ type: "quote", text });
                }
                return;
            }
            if (tag === "pre") {
                const code = extractCodeBlocksFromHtml(fragment)[0];
                if (code) segments.push({ type: "code", text: code.code, language: code.language });
                return;
            }
            if (tag === "ul") {
                extractListItemsFromHtml(fragment, false).forEach((text) => segments.push({ type: "bulleted", text }));
                return;
            }
            if (tag === "ol") {
                extractListItemsFromHtml(fragment, true).forEach((text) => segments.push({ type: "numbered", text }));
                return;
            }
            if (tag === "figure" || tag === "img") {
                extractImageUrlsFromHtml(fragment).forEach((url) => pushImageSegment(url));
                return;
            }
            if (tag === "a") {
                const links = extractLinkItemsFromHtml(fragment);
                links.forEach((item) => {
                    if (item.isImageOnly) return;
                    if (item.url) segments.push({ type: "bookmark", url: item.url, text: item.text || item.url });
                });
                if (!links.length) {
                    const text = htmlToPlainText(fragment).trim();
                    if (text) segments.push({ type: "paragraph", text });
                }
                return;
            }
            if (tag === "p" || tag === "div") {
                const images = extractImageUrlsFromHtml(fragment);
                images.forEach((url) => pushImageSegment(url));
                const paragraph = buildNotionParagraphBlockFromHtml(fragment);
                if (paragraph) segments.push({ type: "paragraph_html", block: paragraph });
                return;
            }
            const text = htmlToPlainText(fragment).trim();
            if (text) segments.push({ type: "paragraph", text });
        };

        const pattern = /<(h[1-3]|p|pre|blockquote|ul|ol|figure|aside|div|a)[^>]*>[\s\S]*?<\/\1>|<img[^>]*>/gi;
        let lastIndex = 0;
        let match;
        while ((match = pattern.exec(source))) {
            if (match.index > lastIndex) {
                const plain = htmlToPlainText(source.slice(lastIndex, match.index)).trim();
                if (plain) segments.push({ type: "paragraph", text: plain });
            }
            pushFragment(match[0], match[1] || "img");
            lastIndex = pattern.lastIndex;
        }

        if (lastIndex < source.length) {
            const plain = htmlToPlainText(source.slice(lastIndex)).trim();
            if (plain) segments.push({ type: "paragraph", text: plain });
        }

        return segments;
    }

    function buildNotionPostBlocks(post, index) {
        const blocks = [];
        const author = post?.name || post?.username || `用户${index + 1}`;
        const floor = post?.post_number ? `#${post.post_number}` : `第${index + 1}条`;
        const dateText = post?.created_at ? new Date(post.created_at).toLocaleString("zh-CN") : "";
        const header = [floor, author, dateText].filter(Boolean).join(" · ");
        blocks.push(buildNotionCalloutBlock(header, index === 0 ? "📌" : "💬"));

        if (post?.reply_to_post_number) {
            blocks.push(buildNotionCalloutBlock(`回复 #${post.reply_to_post_number} 楼`, "↩️"));
        }

        const html = String(post?.cooked || "");
        const seenBookmarks = new Set();
        const seenImages = new Set();
        const segments = splitHtmlIntoTopLevelSegments(html);

        segments.forEach((segment) => {
            if (!segment) return;
            if (segment.type === "heading" && segment.text) {
                blocks.push(buildNotionHeadingBlock(segment.level, segment.text));
                return;
            }
            if (segment.type === "paragraph_html" && segment.block) {
                blocks.push(segment.block);
                return;
            }
            if (segment.type === "paragraph" && segment.text) {
                blocks.push(buildNotionParagraphBlock(segment.text));
                return;
            }
            if (segment.type === "quote_html" && segment.block) {
                blocks.push(segment.block);
                return;
            }
            if (segment.type === "quote" && segment.text) {
                blocks.push(buildNotionQuoteBlock(segment.text));
                return;
            }
            if (segment.type === "code" && segment.text) {
                blocks.push(buildNotionCodeBlock(segment.text.split("\n"), segment.language || "plain text"));
                return;
            }
            if (segment.type === "bulleted" && segment.text) {
                blocks.push(buildNotionBulletedListItemBlock(segment.text));
                return;
            }
            if (segment.type === "numbered" && segment.text) {
                blocks.push(buildNotionNumberedListItemBlock(segment.text));
                return;
            }
            if (segment.type === "image" && segment.url) {
                const normalized = normalizeImageUrl(segment.url);
                if (!normalized || seenImages.has(normalized)) return;
                const img = buildNotionImageBlock(normalized);
                if (img) {
                    seenImages.add(normalized);
                    blocks.push(img);
                }
                return;
            }
            if (segment.type === "bookmark" && segment.url && !seenBookmarks.has(segment.url)) {
                const bookmark = buildNotionBookmarkBlock(segment.url, segment.text || segment.url);
                if (bookmark) {
                    seenBookmarks.add(segment.url);
                    blocks.push(bookmark);
                }
            }
        });

        if (blocks.length === 1) {
            const plainText = htmlToPlainText(html);
            if (plainText) {
                plainText.split(/\n{2,}/).map((text) => text.trim()).filter(Boolean).forEach((text) => {
                    blocks.push(buildNotionParagraphBlock(text));
                });
            }
        }

        return blocks;
    }

    function buildNotionContentBlocks(payload) {
        const posts = Array.isArray(payload.posts) ? payload.posts : [];
        if (!posts.length) {
            return markdownToNotionBlocks(payload.markdown || "");
        }

        return posts.flatMap((post, index) => {
            const blocks = buildNotionPostBlocks(post, index);
            if (index < posts.length - 1 && blocks.length) {
                blocks.push({ object: "block", type: "divider", divider: {} });
            }
            return blocks;
        });
    }

    function buildNotionParagraphBlocks(text) {
        return markdownToNotionBlocks(text);
    }

    async function appendBlocksToNotionPage(pageId, blocks, apiKey) {
        const pageBlocks = Array.isArray(blocks) ? blocks : [];
        if (!pageBlocks.length) return;

        const batchSize = 100;
        for (let i = 0; i < pageBlocks.length; i += batchSize) {
            await requestNotion(
                `/blocks/${pageId}/children`,
                {
                    method: "PATCH",
                    body: JSON.stringify({ children: pageBlocks.slice(i, i + batchSize) }),
                },
                apiKey
            );
        }
    }

    function buildNotionTitleRichText(text) {
        return [{
            type: "text",
            text: { content: String(text || "").slice(0, 2000) || "Untitled" },
        }];
    }

    function buildNotionPageProperties(payload, databaseSchema = {}) {
        const properties = {};
        const titleKey = Object.keys(databaseSchema).find((key) => databaseSchema[key]?.type === "title") || "Name";
        properties[titleKey] = { title: buildNotionTitleRichText(payload.title) };

        if (databaseSchema["链接"]?.type === "url") {
            properties["链接"] = { url: payload.url || null };
        } else if (databaseSchema.URL?.type === "url") {
            properties.URL = { url: payload.url || null };
        }

        const categoryValues = (payload.categories || payload.category || [])
            .flatMap((item) => Array.isArray(item) ? item : [item])
            .map((item) => String(item || "").trim())
            .filter(Boolean);
        if (databaseSchema["分类"]?.type === "multi_select") {
            properties["分类"] = { multi_select: [...new Set(categoryValues)].map((name) => ({ name })) };
        } else if (databaseSchema.Category?.type === "multi_select") {
            properties.Category = { multi_select: [...new Set(categoryValues)].map((name) => ({ name })) };
        }

        const tagValues = (payload.tags || []).map((tag) => String(tag || "").trim()).filter(Boolean);
        if (databaseSchema["标签"]?.type === "multi_select") {
            properties["标签"] = { multi_select: [...new Set(tagValues)].map((name) => ({ name })) };
        } else if (databaseSchema.Tags?.type === "multi_select") {
            properties.Tags = { multi_select: [...new Set(tagValues)].map((name) => ({ name })) };
        }

        if (databaseSchema["来源"]?.type === "select") {
            properties["来源"] = { select: { name: payload.source || "Linux.do" } };
        } else if (databaseSchema.Source?.type === "select") {
            properties.Source = { select: { name: payload.source || "Linux.do" } };
        }

        if (databaseSchema["主题ID"]?.type === "rich_text") {
            properties["主题ID"] = { rich_text: buildNotionTitleRichText(String(payload.topicId || "")) };
        } else if (databaseSchema.TopicID?.type === "rich_text") {
            properties.TopicID = { rich_text: buildNotionTitleRichText(String(payload.topicId || "")) };
        }

        if (databaseSchema["摘要"]?.type === "rich_text") {
            properties["摘要"] = { rich_text: buildNotionTitleRichText(payload.summary || "") };
        } else if (databaseSchema.Summary?.type === "rich_text") {
            properties.Summary = { rich_text: buildNotionTitleRichText(payload.summary || "") };
        }
        return properties;
    }

    async function createNotionExport(payload, settings) {
        const apiKey = settings?.notion?.apiKey || "";
        const databaseId = normalizeNotionId(settings?.notion?.databaseId);
        const parentPageId = normalizeNotionId(settings?.notion?.parentPageId);

        if (!databaseId && !parentPageId) {
            throw new Error("请先配置 Notion Database ID 或 Parent Page ID");
        }

        let parent;
        let databaseSchema = null;
        if (databaseId) {
            const dbInfo = await requestNotion(`/databases/${databaseId}`, { method: "GET", headers: { "Content-Type": undefined } }, apiKey);
            databaseSchema = dbInfo?.properties || {};
            parent = { database_id: databaseId };
        } else {
            parent = { page_id: parentPageId };
        }

        const children = buildNotionContentBlocks(payload);
        const initialChildren = children.slice(0, 100);
        const remainingChildren = children.slice(100);
        const createPayload = {
            parent,
            properties: databaseId
                ? buildNotionPageProperties(payload, databaseSchema)
                : { title: { title: buildNotionTitleRichText(payload.title) } },
            children: initialChildren,
        };

        if (!databaseId) {
            createPayload.icon = { type: "emoji", emoji: "📌" };
        }

        const page = await requestNotion("/pages", { method: "POST", body: JSON.stringify(createPayload) }, apiKey);
        if (remainingChildren.length && page?.id) {
            await appendBlocksToNotionPage(page.id, remainingChildren, apiKey);
        }
        return page;
    }


    function cloneExportSettings(settings) {
        return {
            ...settings,
            filters: { ...(settings?.filters || {}) },
            ai: { ...(settings?.ai || {}) },
            notion: { ...(settings?.notion || {}) },
        };
    }

    function buildTargetExportSettings(settings, target) {
        return cloneExportSettings(settings);
    }


    // -----------------------
    // Markdown 生成
    // -----------------------
    function escapeYaml(str) {
        return String(str || "").replace(/"/g, '\\"').replace(/\n/g, "\\n");
    }

    function generateMarkdownDocument(topic, posts, settings, imgMap, filterSummary, options = {}) {
        const now = new Date();
        const exportTemplate = normalizeExportTemplate(settings?.exportTemplate);
        const exportTarget = options?.target === "notion" ? "notion" : "markdown";
        const displayTitle = replaceEmojiShortcodes(topic.title || "无标题");

        const allTags = exportTarget === "notion"
            ? [...new Set([...(topic.tags || []), "discourse", "公开导出"])]
            : [...new Set(["公开导出", ...(topic.tags || []), "discourse"])];
        const tagsYaml = allTags.map((t) => `  - "${escapeYaml(t)}"`).join("\n");
        const frontmatter = `---\ntitle: "${escapeYaml(displayTitle)}"\ntopic_id: ${topic.topicId || 0}\nurl: "${topic.url || ""}"\nauthor: "${escapeYaml(topic.opUsername || "")}"\ncategory: "${escapeYaml(topic.category || "")}"\ntags:\n${tagsYaml}\nexport_time: "${now.toISOString()}"\nfloors: ${posts.length}\n---\n\n`;

        let content = `# ${displayTitle}\n\n`;
        content += `> [!info] 帖子信息\n`;
        content += `> - **原始链接**: [${topic.url || ""}](${topic.url || ""})\n`;
        content += `> - **主题 ID**: ${topic.topicId || 0}\n`;
        content += `> - **楼主**: @${topic.opUsername || "未知"}\n`;
        content += `> - **分类**: ${topic.category || "无"}\n`;
        content += `> - **标签**: ${allTags.join(", ")}\n`;
        content += `> - **导出时间**: ${now.toLocaleString("zh-CN")}\n`;
        content += `> - **楼层数**: ${posts.length}\n`;
        if (exportTemplate === "forum" && filterSummary) {
            content += `> - **筛选条件**: ${filterSummary}\n`;
        }
        content += `\n`;


        if (exportTemplate === "clean") {
            const primaryPost = getPrimaryPost(posts);
            if (!primaryPost) throw new Error("未找到首帖，无法按纯净风格导出");

            const bodyMd = renderPrimaryPostMarkdown(primaryPost, settings, imgMap);
            if (bodyMd) {
                content += `${bodyMd}\n`;
            }
            return frontmatter + content;
        }

        const { firstPost, remainingPosts } = splitPinnedFirstPost(posts);
        if (!firstPost) throw new Error("未找到首帖，无法按论坛风格导出");

        const firstPostMd = renderPrimaryPostMarkdown(firstPost, settings, imgMap, { includeAnchor: true });
        if (firstPostMd) {
            content += `${firstPostMd}\n\n`;
        }

        for (const p of remainingPosts) {
            content += generatePostCallout(p, topic, settings, imgMap);
            content += "\n";
        }

        return frontmatter + content;
    }
    function renderPrimaryPostMarkdown(post, settings, imgMap, options = {}) {
        const bodyMd = cookedToMarkdown(post?.cooked || "", settings, imgMap);
        if (!options.includeAnchor) return bodyMd;

        const anchor = `^floor-${Number(post?.post_number || 1)}`;
        return bodyMd ? `${bodyMd}\n\n${anchor}` : anchor;
    }

    function generatePostCallout(post, topic, settings, imgMap) {
        const isOp = (post.username || "").toLowerCase() === (topic.opUsername || "").toLowerCase();
        const dateStr = post.created_at ? new Date(post.created_at).toLocaleString("zh-CN") : "";

        const calloutType = isOp ? "success" : "note";
        const opBadge = isOp ? " 🏠 楼主" : "";

        let title = `#${post.post_number} ${post.name || post.username || "匿名"}`;
        if (post.name && post.username && post.name !== post.username) {
            title += ` (@${post.username})`;
        }
        title += opBadge;
        if (dateStr) title += ` · ${dateStr}`;

        let md = `> [!${calloutType}]+ ${title}\n`;

        if (post.reply_to_post_number) {
            md += `> > 回复 [[#^floor-${post.reply_to_post_number}|#${post.reply_to_post_number}楼]]\n>\n`;
        }

        const bodyMd = cookedToMarkdown(post.cooked, settings, imgMap);
        const lines = bodyMd.split("\n");
        for (const line of lines) {
            md += `> ${line}\n`;
        }

        md += `> ^floor-${post.post_number}\n`;

        return md;
    }

    function buildDuplicatePathDetails(matches, limit = 3) {
        const items = (Array.isArray(matches) ? matches : [])
            .map((item) => item?.path || item)
            .filter(Boolean)
            .slice(0, limit);

        const remaining = Math.max(0, (Array.isArray(matches) ? matches.length : 0) - items.length);
        if (remaining > 0) {
            items.push(`还有 ${remaining} 条其他命中…`);
        }
        return items;
    }

    function getTopicId() {
        const path = location.pathname || "";
        const match = path.match(/\/t\/(?:topic\/)?[^/]+\/(\d+)(?:\/.*)?$/) || path.match(/\/t\/(\d+)(?:\/.*)?$/);
        return match ? Number(match[1]) : null;
    }

    function readStoredValue(key, fallback = "") {
        try {
            const value = GM_getValue(key, fallback);
            return value == null ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function saveStoredValue(key, value) {
        try {
            GM_setValue(key, value);
        } catch (_) {}
    }

    function getSettings() {
        return {
            exportTemplate: readStoredValue(K.EXPORT_TEMPLATE, DEFAULTS.exportTemplate),
            notion: {
                apiKey: readStoredValue(K.NOTION_API_KEY, DEFAULTS.notionApiKey),
                parentPageId: readStoredValue(K.NOTION_PARENT_PAGE_ID, DEFAULTS.notionParentPageId),
                databaseId: readStoredValue(K.NOTION_DATABASE_ID, DEFAULTS.notionDatabaseId),
            },
            includeReplies: String(readStoredValue(K.INCLUDE_REPLIES, DEFAULTS.includeReplies ? "1" : "0")) === "1",
        };
    }

    function triggerBrowserDownload(url, filename) {
        const link = document.createElement("a");
        link.href = url;
        link.download = filename;
        link.style.display = "none";
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 30_000);
    }

    function normalizeExportTemplate(value) {
        return value === "clean" ? "clean" : "forum";
    }

    function replaceEmojiShortcodes(text) {
        return String(text || "").replace(/:([a-z0-9_+-]+):/gi, "$1");
    }

    function getPrimaryPost(posts) {
        return Array.isArray(posts) && posts.length ? posts[0] : null;
    }

    function splitPinnedFirstPost(posts) {
        const list = Array.isArray(posts) ? posts.slice() : [];
        return { firstPost: list[0] || null, remainingPosts: list.slice(1) };
    }

    function cookedToMarkdown(html) {
        const source = String(html || "");
        return decodeHtmlEntities(source
            .replace(/<br\s*\/?>/gi, "\n")
            .replace(/<\/p>/gi, "\n\n")
            .replace(/<\/div>/gi, "\n")
            .replace(/<\/li>/gi, "\n")
            .replace(/<li[^>]*>/gi, "- ")
            .replace(/<img[^>]+alt=["']([^"']*)["'][^>]*>/gi, (_, alt) => alt ? `![${alt}]` : "")
            .replace(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
                const url = sanitizeExternalUrl(href);
                const label = stripHtmlTags(text) || url;
                if (!url) return label || "";
                return `[${label}](${url})`;
            })
            .replace(/<[^>]+>/g, ""))
            .trim();
    }

    function buildExportOutcomeNotes(aiOutcome, extra = []) {
        const notes = Array.isArray(extra) ? extra.slice() : [];
        if (aiOutcome?.skipped) notes.push("AI 筛选未启用");
        return notes;
    }

    async function fetchTopicFromDiscourse(topicId) {
        const normalizedId = Number(topicId || 0);
        if (!normalizedId) throw new Error("未识别到主题 ID");

        const base = `${location.origin}/t/${normalizedId}.json`;
        const response = await fetch(base, { credentials: "include" });
        if (!response.ok) {
            throw new Error(`拉取主题数据失败：HTTP ${response.status}`);
        }

        const topic = await response.json();
        const posts = Array.isArray(topic?.post_stream?.posts) ? topic.post_stream.posts : [];
        return {
            topic,
            posts,
        };
    }

    async function buildExportContext(target, settings) {
        const topicId = getTopicId();
        const title = document.querySelector("title")?.textContent?.replace(/\s*-\s*Linux\.do.*$/i, "").trim() || document.title || "未命名主题";
        const topicData = await fetchTopicFromDiscourse(topicId);
        const rawTopic = topicData.topic || {};
        const rawPosts = Array.isArray(topicData.posts) ? topicData.posts : [];
        const topic = {
            topicId,
            title: rawTopic.title || title,
            url: location.href,
            opUsername: rawTopic.details?.created_by?.username || rawPosts[0]?.username || "",
            category: document.querySelector('.category-name')?.textContent?.trim() || rawTopic.category_name || "",
            tags: Array.isArray(rawTopic.tags) ? rawTopic.tags.filter(Boolean) : Array.from(document.querySelectorAll('.discourse-tags .discourse-tag')).map((el) => el.textContent?.trim()).filter(Boolean),
        };
        const posts = rawPosts.map((post, index) => ({
            post_number: Number(post?.post_number || index + 1),
            username: post?.username || "",
            name: post?.name || "",
            created_at: post?.created_at || "",
            cooked: post?.cooked || "",
            reply_to_post_number: Number(post?.reply_to_post_number || 0) || null,
        })).filter((item) => item.cooked);
        const includeReplies = !!settings?.includeReplies;
        const selectedPosts = includeReplies ? posts : (posts[0] ? [posts[0]] : []);
        const filterSummary = selectedPosts.length
            ? (includeReplies ? `楼主正文 + 回复（共 ${selectedPosts.length} 条）` : `仅楼主正文（共 ${selectedPosts.length} 条）`)
            : "无可导出正文";
        return {
            target,
            settings,
            topicId,
            topic,
            selected: selectedPosts,
            posts,
            imgMap: new Map(),
            filterSummary,
            aiOutcome: { skipped: true },
        };
    }

    async function buildMarkdownExportPayload(target, context) {
        const markdown = generateMarkdownDocument(
            context.topic,
            context.selected,
            context.settings,
            context.imgMap,
            context.filterSummary,
            { target }
        );
        const safeTitle = String(context.topic?.title || "discourse-topic")
            .replace(/[\\/:*?"<>|]+/g, "-")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 80) || "discourse-topic";
        return {
            markdown,
            filename: `${safeTitle}.md`,
            settings: context.settings,
            aiOutcome: context.aiOutcome,
        };
    }

    const ui = {
        initialized: false,
        root: null,
        statusEl: null,
        progressEl: null,
        btnMarkdown: null,
        btnNotion: null,
        fallbackEl: null,
        init() {
            if (this.initialized) return;
            this.initialized = true;

            const root = document.createElement("div");
            root.id = "ld-export-panel";
            root.style.cssText = [
                "position:fixed",
                "right:16px",
                "bottom:16px",
                "z-index:999999",
                "width:220px",
                "background:#111827",
                "color:#f9fafb",
                "border:1px solid rgba(255,255,255,.12)",
                "border-radius:14px",
                "box-shadow:0 12px 30px rgba(0,0,0,.35)",
                "padding:12px",
                "font:13px/1.45 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,sans-serif",
            ].join(";");

            root.innerHTML = `
                <div style="font-weight:700;margin-bottom:10px;">导出当前主题</div>
                <label style="display:flex;align-items:center;gap:8px;margin:0 0 10px 0;color:#e5e7eb;cursor:pointer;font-size:12px;">
                    <input type="checkbox" data-role="include-replies" style="margin:0;accent-color:#7c3aed;">
                    <span>连同楼层回复一起收藏</span>
                </label>
                <div style="display:flex;gap:8px;margin-bottom:8px;">
                    <button type="button" data-role="markdown" style="flex:1;border:0;border-radius:10px;padding:8px 10px;background:#2563eb;color:#fff;cursor:pointer;">下载文稿</button>
                    <button type="button" data-role="notion" style="flex:1;border:0;border-radius:10px;padding:8px 10px;background:#7c3aed;color:#fff;cursor:pointer;">存到收藏</button>
                </div>
                <div data-role="status" style="min-height:18px;color:#cbd5e1;">已就绪</div>
                <div data-role="progress" style="margin-top:4px;color:#94a3b8;font-size:12px;"></div>
                <a data-role="fallback" style="display:none;margin-top:8px;color:#93c5fd;word-break:break-all;" target="_blank" rel="noopener">下载文件</a>
            `;

            document.body.appendChild(root);
            this.root = root;
            this.statusEl = root.querySelector('[data-role="status"]');
            this.progressEl = root.querySelector('[data-role="progress"]');
            this.btnMarkdown = root.querySelector('[data-role="markdown"]');
            this.btnNotion = root.querySelector('[data-role="notion"]');
            this.fallbackEl = root.querySelector('[data-role="fallback"]');
            this.includeRepliesEl = root.querySelector('[data-role="include-replies"]');
            if (this.includeRepliesEl) {
                this.includeRepliesEl.checked = !!getSettings().includeReplies;
                this.includeRepliesEl.addEventListener("change", () => {
                    saveStoredValue(K.INCLUDE_REPLIES, this.includeRepliesEl.checked ? "1" : "0");
                });
            }
        },
        getSettings,
        setBusy(busy) {
            [this.btnMarkdown, this.btnNotion, this.includeRepliesEl].forEach((btn) => {
                if (btn) btn.disabled = !!busy;
            });
        },
        setStatus(text, color) {
            if (this.statusEl) {
                this.statusEl.textContent = text || "";
                if (color) this.statusEl.style.color = color;
            }
        },
        setProgress(current, total, text) {
            if (!this.progressEl) return;
            this.progressEl.textContent = text || `${current}/${total}`;
        },
        clearDownloadFallback() {
            if (!this.fallbackEl) return;
            this.fallbackEl.style.display = "none";
            this.fallbackEl.removeAttribute("href");
            this.fallbackEl.textContent = "下载文件";
        },
        setDownloadFallback(url, filename) {
            if (!this.fallbackEl) return;
            this.fallbackEl.href = url;
            this.fallbackEl.download = filename || "export.md";
            this.fallbackEl.textContent = `如果浏览器未自动下载，点这里：${filename || "export.md"}`;
            this.fallbackEl.style.display = "block";
        },
    };

    async function exportMarkdownDownload() {
        ui.init();
        ui.clearDownloadFallback();
        ui.setBusy(true);
        ui.setStatus("正在拉取帖子内容…", "#a855f7");
        ui.setProgress(0, 1, "准备中");

        try {
            const baseSettings = ui.getSettings();
            const context = await buildExportContext("markdown", baseSettings);
            const payload = await buildMarkdownExportPayload("markdown", context);

            ui.setStatus("正在准备浏览器下载…", "#a855f7");
            const blob = new Blob([payload.markdown], { type: "text/markdown;charset=utf-8" });
            const downloadUrl = URL.createObjectURL(blob);
            ui.setDownloadFallback(downloadUrl, payload.filename);
            triggerBrowserDownload(downloadUrl, payload.filename);

            ui.setProgress(1, 1, "导出完成");
            const finalNotes = buildExportOutcomeNotes(payload.aiOutcome);
            const suffix = finalNotes.length ? `（${finalNotes.join("；")}）` : "";
            ui.setStatus(`✅ 已下载 Markdown: ${payload.filename}${suffix}`, "#6ee7b7");
        } catch (e) {
            console.error(e);
            ui.setStatus("导出失败：" + (e?.message || e), "#fecaca");
            alert("Markdown 导出失败：" + (e?.message || e));
        } finally {
            ui.setBusy(false);
        }
    }

    async function exportToNotion() {
        ui.init();
        ui.clearDownloadFallback();
        ui.setBusy(true);
        ui.setStatus("正在拉取帖子内容…", "#a855f7");
        ui.setProgress(0, 1, "准备中");

        try {
            const baseSettings = ui.getSettings();
            if (!baseSettings.notion?.apiKey) {
                ui.setStatus("⚠️ 请先配置 Notion API Key", "#facc15");
                return;
            }
            if (!baseSettings.notion?.databaseId && !baseSettings.notion?.parentPageId) {
                ui.setStatus("⚠️ 请先填写 Notion Database ID 或 Parent Page ID", "#facc15");
                return;
            }

            const context = await buildExportContext("notion", baseSettings);
            const payload = await buildMarkdownExportPayload("notion", context);
            ui.setStatus("正在写入 Notion…", "#a855f7");

            const notionResult = await createNotionExport({
                title: context.topic?.title || payload.filename,
                url: context.topic?.url || "",
                topicId: context.topicId,
                tags: [...new Set(["公开导出", "discourse", ...((context.topic && context.topic.tags) || [])])],
                categories: [context.topic?.category, "文章"],
                source: "Linux.do",
                summary: `导出楼层数：${context.selected.length}`,
                markdown: payload.markdown,
                posts: context.selected,
            }, payload.settings);

            ui.setProgress(1, 1, "导出完成");
            const finalNotes = buildExportOutcomeNotes(payload.aiOutcome, ["已写入 Notion"]);
            const suffix = finalNotes.length ? `（${finalNotes.join("；")}）` : "";
            ui.setStatus(`✅ 已导出到 Notion${suffix}`, "#6ee7b7");
            console.log("Notion export result", notionResult);
        } catch (e) {
            console.error(e);
            ui.setStatus("导出失败：" + (e?.message || e), "#fecaca");
            alert("Notion 导出失败：" + (e?.message || e));
        } finally {
            ui.setBusy(false);
        }
    }

    // -----------------------
    // 入口
    // -----------------------
    let hasInitialized = false;

    function init() {
        const topicId = getTopicId();
        if (!topicId) return;

        if (!ui.root || !document.body.contains(ui.root)) {
            hasInitialized = false;
        }
        if (hasInitialized) return;

        hasInitialized = true;
        ui.init();

        ui.btnMarkdown.addEventListener("click", exportMarkdownDownload);
        ui.btnNotion.addEventListener("click", exportToNotion);
    }

    function ensureUiMounted() {
        init();
        if (!ui.root || !document.body) return;
        if (!document.body.contains(ui.root)) {
            hasInitialized = false;
            init();
        }
    }

    if (document.readyState === "complete" || document.readyState === "interactive") {
        ensureUiMounted();
    } else {
        document.addEventListener("DOMContentLoaded", ensureUiMounted, { once: true });
        window.addEventListener("load", ensureUiMounted, { once: true });
    }

    const routeObserver = new MutationObserver(() => {
        ensureUiMounted();
    });
    routeObserver.observe(document.documentElement || document.body, { childList: true, subtree: true });
    window.addEventListener("popstate", ensureUiMounted);
    window.addEventListener("hashchange", ensureUiMounted);
    setInterval(ensureUiMounted, 1500);
})();

/*
========================================
公开版配置说明
========================================
1. 首次使用前，请先在脚本顶部 DEFAULTS 中填写：
   - notionApiKey: 你的 Notion 集成密钥
   - notionDatabaseId: 你的 Notion 数据库 ID
   - notionParentPageId: 如果你不用数据库，改填父页面 ID

2. 三者关系：
   - 优先使用 notionDatabaseId
   - 如果没填数据库 ID，则使用 notionParentPageId

3. 如何获取：
   - Notion API Key：在 Notion integrations 页面创建集成后获得
   - Database ID / Page ID：打开对应页面，从 URL 中复制 32 位 ID

4. 使用前别忘了：
   - 把目标数据库或页面共享给你的 Notion integration
   - Tampermonkey 中允许脚本联网到 api.notion.com

5. 默认行为：
   - 默认只导出楼主正文
   - 勾选“连同楼层回复一起收藏”后，会连回复一起导出
*/
