# dsh-client-paste-image

中文 | [English](README.en.md)

DeepSeek Harness（DSH）Web 客户端插件：**粘贴图片 → 落盘为文件路径**。

## 解决什么

纯文本模型（DeepSeek / GLM 等）无法接收粘贴的图片——composer 直接弹"该模型不支持视觉，请切换视觉模型"。本插件在捕获阶段拦截剪贴板图片粘贴，把图片字节经 [dsh-drop-caret](https://www.npmjs.com/package/dsh-drop-caret) 的宿主路由 `POST /api/dsh-drop` 存为会话目录下的内容寻址文件，并把**文件路径**插入输入框。会话从此保持纯文本；模型需要看图时，把路径交给有视觉能力的模型去处理（如 workflow 按 agent 指定视觉模型，或任何 vision 工具）。

## 依赖

- **dsh-drop-caret**（提供上传路由与文件落盘；本插件纯浏览器侧，宿主半为空）

## 行为

- **只对配置列出的纯文本路由生效**（`textOnlyRoutes`，`provider/model` 通配模式）：列表内的模型粘贴图片 → 转路径；**视觉模型及其它一切模型完全不受影响**——原生缩略图、草稿附件、图片准入管线原样运行
- 列表为空 = 处处不拦截（fail-safe，等同未安装）
- 拦截范围：composer（textarea / contenteditable）内的图片粘贴；纯文本粘贴不碰
- 文件落在 `<会话cwd>/.dsh-drop/<sessionId>/`（drop-caret 的既定布局）
- 插入形式：文件名标签 + 发送时序列化为纯路径文本（自带 trigger source codec）
- **Alt+粘贴**：绕过拦截，走产品原生行为
- 操作反馈：底部 toast（成功显示文件名，失败显示原因）

> v0.3.0 重写接线（v0.2.x 的门控从未生效，两个根因）：① 静态 client 插件**收不到任何 config**——boot manifest 只带 id/url/rev/inject，`loader.create({name})` 也不传，host 半现在通过 `GET /plugin-paste-image-config`（loopback/Origin 信任闸门）把 `cordis.patch.yml` 里的 `textOnlyRoutes` 桥接给浏览器，client 启动时拉取缓存；② 会话 id 不能从服务属性读——conversation 插槽把 `sessionId` 经 `inject(sessionId)` 喂给注入组件（drop-caret 同款机制），隐形探测组件记录给粘贴监听器。配置未到达/获取失败一律不拦截（fail-safe）。含浏览器侧冒烟测试 `test/smoke.mjs`（11 例：门控、glob、启动竞态、fail-safe、Alt 绕过、纯文本、非 composer）。

配置示例：

```yaml
- id: ui-paste-image
  name: dsh-client-paste-image
  config:
    textOnlyRoutes:
      - zai-coding-cn/glm-5.3
      - "opencode-go/deepseek-*"   # 通配
```

## 安装

```bash
cp -r dsh-client-paste-image ~/.dsh/profiles/web/node_modules/
```

在 `~/.dsh/profiles/web/cordis.patch.yml` 的 `- insert:` 列表加入：

```yaml
    - id: ui-paste-image
      name: dsh-client-paste-image
```

（包内 `cordis.patch.yml` 供 `dsh plugin add` / 市场安装使用。）

## 文件说明

| 文件 | 说明 |
|------|------|
| `client.js` | 浏览器侧：粘贴拦截 + 上传 + 路径引用插入（复用 drop-caret 机制） |
| `index.js` | 宿主侧空占位（loader 要求存在） |

兼容性：随 `@deepseek-ai/dsh` 0.1.0-rc.6 测试通过。

## License

MIT
