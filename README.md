# Discourse 导出到 Notion / 文稿（公开版）

这是一个用于 **Discourse / Linux.do 主题页** 的油猴脚本。

它提供两个核心能力：
- **下载文稿**：把当前主题导出为本地 `.md` 文稿
- **存到收藏**：把当前主题直接写入 Notion

这个公开版已经去掉私有默认配置，适合直接分发、备份或二次修改。

---

## 功能概览

### 1）下载文稿
- 导出当前主题为本地 Markdown 文件
- 默认只导出 **楼主正文**
- 可勾选“**连同楼层回复一起收藏**”把回复一起纳入导出
- 文稿会包含：
  - 标题
  - 原帖链接
  - 主题 ID
  - 楼主
  - 分类
  - 标签
  - 导出时间
  - 楼层数
  - 正文内容

### 2）导出到 Notion
- 直接调用 Notion API 创建页面
- 支持两种目标：
  - **数据库**
  - **普通父页面**
- 优先使用 **数据库 ID**；未填写数据库 ID 时，退回使用 **父页面 ID**
- 支持把帖子正文尽量映射为原生 Notion 块，包括：
  - 标题
  - 段落
  - 引用
  - 无序列表
  - 有序列表
  - 代码块
  - 分隔线
  - 图片块
  - 书签块
  - 帖子头部提示块

### 3）正文提取方式更稳
脚本不是只抓当前页面已渲染的 DOM，而是直接请求：

```text
/t/{topicId}.json
```

这样可以更稳定地拿到完整帖子数据，避免长帖、懒加载、虚拟渲染导致导出不全。

### 4）图片与链接保留更完整
- 会尽量恢复帖子里的原始图片地址
- 对图片附件说明文本做清洗，减少导入后出现类似 `image770×329 7.38 KB` 这种脏文本
- 普通超链接尽量保留为可点击链接
- 顶层外链会尽量转成 Notion 书签块

---

## 适用场景

适合这些需求：
- 收藏 Linux.do / Discourse 主题到 Notion
- 备份高价值帖子为 Markdown 文稿
- 只保存楼主正文，避免评论噪音
- 或者按需把整串回复一起导出保存

---

## 安装方法

### 方式一：安装油猴扩展
先安装任一用户脚本管理器：
- Tampermonkey
- Violentmonkey
- ScriptCat

然后导入本仓库中的脚本文件：

```text
discourse2notion-public.user.js
```

### 方式二：从本地文件导入
如果你已经拿到了脚本文件，直接拖进油猴扩展安装页面即可。

---

## 配置前先了解

脚本本身支持 Notion 导出，但 **公开版不会内置你的私密配置**。

也就是说，你需要自己填写：
- Notion API Key
- Notion Database ID
- 或 Parent Page ID

---

## 如何获取 Notion 配置

### 1）获取 Notion API Key
在 Notion 后台创建一个 integration。

一般路径是：
- 打开 Notion 开发者平台
- 创建一个 integration
- 复制生成的密钥

拿到的就是脚本里要用的：

```text
Notion API Key
```

### 2）获取 Database ID 或 Page ID
打开你的 Notion 数据库页面或普通页面，浏览器地址栏里会有一段 32 位左右的 ID。

例如：

```text
https://www.notion.so/xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx?v=yyyy
```

其中这一段就是页面或数据库 ID：

```text
xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

脚本会自动兼容是否带短横线；你填有无短横线都可以。

### 3）把页面/数据库共享给 integration
这一步非常重要。

如果没共享，脚本即使 token 正确，也会因为权限不足而失败。

你需要在 Notion 中：
- 打开目标数据库或目标页面
- 点击分享
- 把你创建的 integration 加进去

---

## 推荐配置策略

### 优先推荐：填写数据库 ID
如果你希望每次导出都进入一个固定收藏库，推荐只填写：

```text
notionDatabaseId
```

这样脚本会把当前帖子作为数据库中的一条新页面写进去。

### 备选方案：填写父页面 ID
如果你不想放进数据库，只想在某个普通页面下创建子页面，就填写：

```text
notionParentPageId
```

### 两者同时存在时
脚本逻辑是：
- 优先使用 `notionDatabaseId`
- 如果数据库 ID 为空，再使用 `notionParentPageId`

---

## 如何填写配置

当前公开版脚本默认值是空的。

请打开脚本，找到这一段：

```javascript
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
    notionApiKey: "",
    notionParentPageId: "",
    notionDatabaseId: "",
    includeReplies: false,
};
```

把其中三项改成你自己的：

```javascript
notionApiKey: "你的 Notion API Key",
notionParentPageId: "你的父页面 ID，可留空",
notionDatabaseId: "你的数据库 ID，可留空",
```

推荐只填：
- `notionApiKey`
- `notionDatabaseId`

如果你不用数据库，再改填 `notionParentPageId`。

---

## 页面上的使用方式

进入任意符合匹配规则的 Discourse 主题页后，页面右下角会出现一个小面板：

- **下载文稿**
- **存到收藏**
- **连同楼层回复一起收藏**（复选框）

### 默认行为
默认只导出：
- 楼主正文

### 勾选复选框后
会导出：
- 楼主正文
- 所有回复

这个勾选状态会被脚本持久化保存，下次打开页面还会保留上次选择。

---

## 导出到 Notion 时会写入什么

如果目标是数据库，脚本会尝试自动识别数据库字段，并优先兼容这些字段名：

- `链接`
- `分类`
- `标签`
- `来源`
- `主题ID`
- `摘要`

同时也兼容英文回退字段：
- `URL`
- `Category`
- `Tags`
- `Source`
- `TopicID`
- `Summary`

标题字段则会自动查找数据库中的 `title` 类型属性。

---

## 导出的 Notion 页面结构

为了尽量让导入结果更接近原生阅读体验，正文会按块结构生成，而不是简单地把整篇 HTML 粗暴去标签。

通常会包含：
- 顶部提示块（楼层、作者、时间）
- 如果是回复楼层，会额外显示“回复 #N 楼”
- 标题
- 段落
- 引用
- 列表
- 代码块
- 图片
- 外链书签
- 多帖之间分隔线

如果你只导出楼主正文，就只生成首帖内容。
如果勾选连回复一起导出，就会按楼层顺序逐条写入。

---

## 文件说明

### `discourse2notion-public.user.js`
公开版脚本，适合直接分享给别人使用。

特点：
- 不带私有密钥
- 不带私有数据库 ID
- 默认配置为空
- 适合仓库发布

### `discourse2notion.user.js`
如果仓库里同时存在这个文件，通常表示它可能是你自己的当前工作版本或私有版本。

如果你要公开发别人安装，建议发：

```text
discourse2notion-public.user.js
```

---

## 常见问题

### 1）页面上没有按钮
先确认：
- 当前页面是不是 Discourse 主题页
- URL 是否匹配：
  - `https://*/t/*`
  - `https://*/t/topic/*`
- 脚本是否已启用
- 油猴扩展是否工作正常

这个脚本已经包含针对局部重渲染的重新挂载逻辑，但如果站点结构改动很大，仍可能需要更新选择器或初始化时机。

---

### 2）点击“存到收藏”失败
优先检查：
- `notionApiKey` 是否正确
- `notionDatabaseId` 或 `notionParentPageId` 是否填写
- 目标页面/数据库是否已经共享给 integration
- 油猴是否允许访问：
  - `api.notion.com`

脚本使用的是：
- `GM_xmlhttpRequest`

不是页面环境里的普通 `fetch` 去调 Notion API，因此跨域稳定性会更好。

---

### 3）导入后图片不显示
这通常与原帖图片地址、站点防盗链、CDN 中转、临时链接失效有关。

脚本已经尽量做了这些处理：
- 优先提取原始图片地址
- 尝试清洗中转参数
- 去掉附件说明脏文本
- 用 Notion 原生 external image block 导入

但如果原站对外链图片有限制，仍可能出现 Notion 端无法加载的情况。

---

### 4）为什么默认只导出楼主正文
这是为了更适合“收藏文章”场景：
- 更干净
- 噪音更少
- 更像文章归档

如果你想保留讨论串，再勾选“连同楼层回复一起收藏”。

---

### 5）为什么我填了父页面 ID，但还是写进数据库了
因为脚本逻辑是：

```text
优先数据库 ID，数据库 ID 为空时才使用父页面 ID
```

所以如果你两个都填了，会优先进入数据库。

---

### 6）Markdown 导出和 Notion 导出有什么区别
**下载文稿**：
- 生成本地 `.md` 文件
- 适合备份、归档、转存到别处

**存到收藏**：
- 直接写入 Notion
- 适合做收藏库、稍后阅读、资料沉淀

---

## 隐私与安全说明

这个公开版不会自带你的私有配置。

请注意：
- 不要把自己的 Notion API Key 直接提交到公开仓库
- 如果你修改后要分享给别人，请先把密钥和页面 ID 清空
- 最好把个人私用版和公开版分开维护

---

## 适合公开发布时的建议

如果你要把这个脚本发给别人：
- 推荐只发布 `discourse2notion-public.user.js`
- README 里明确说明需要自行填写 Notion 配置
- 不要把自己的数据库 ID、页面 ID、token 一起发出去

---

## 开发与验证建议

每次修改脚本后，至少做下面几项检查：

```bash
node --check discourse2notion-public.user.js
```

实际回归建议：
- 打开一个真实 Discourse 主题页
- 确认右下角面板出现
- 测试“下载文稿”是否成功
- 测试“存到收藏”是否成功创建页面
- 检查 Notion 里的正文顺序是否正确
- 检查图片是否以原生图片块显示
- 检查链接是否仍可点击

---

## 适合二次定制的方向

如果你要继续改这个脚本，常见方向包括：
- 自定义默认导出模板
- 自定义 Notion 数据库字段映射
- 调整右下角面板样式
- 增加更多导出目标
- 对特定站点做图片/链接清洗增强
- 调整默认是否导出回复

---

## 已知限制

- 如果站点对 `/t/{topicId}.json` 做了额外风控，脚本可能无法拉取完整数据
- 如果原站图片本身不可外链，Notion 可能无法显示外部图片
- 不同 Discourse 站点的主题 HTML 结构可能存在差异，极端场景下仍需要定向修补
- 数据库字段如果不是常见中文/英文命名，可能需要你自己继续扩展映射逻辑

---

## 致谢

公开整理：**QN**

如果你只是想直接拿去用，最短流程如下：

1. 安装油猴
2. 导入 `discourse2notion-public.user.js`
3. 填入 `notionApiKey`
4. 填入 `notionDatabaseId`（推荐）
5. 把数据库共享给 integration
6. 打开 Discourse 主题页
7. 点击 **存到收藏** 或 **下载文稿**
