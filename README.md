# 黑箱剧场 BlackBox Theater

用 AI 做短剧的 Windows 桌面软件：写剧本、做人物和场景素材、按镜头出视频、挑片、连起来看。出片用的是 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 加 MiniMax H3 视频模型，可以在本机显卡上跑，也可以放到租的云 GPU（比如 AutoDL）上跑。

> Windows 桌面端目前从源码启动。AutoDL 用户可以在软件里安装云端环境和模型，完成后会收到一份真实生成的验收素材。

## 能做什么

| 页面 | 做什么 |
|---|---|
| 剧本 | 写剧本，和 AI 讨论修改；「拆分镜」把整份剧本交给 AI，自动列出人物、场景和每集的镜头，检查后逐镜写好视频提示词 |
| 素材 | 按剧本里的人物和场景，用 Qwen-Image 2.1 出定妆图和场景图 |
| 场景 | 用 AI 按设定搭建筑白模，检查空间关系 |
| 镜头 | 每个镜头抽卡出视频、挑片，前后镜头自动接续 |
| 成片 | 把挑好的镜头连起来看，选中的镜头可以用 SeedVR2 超分放大 |
| 设置 | ComfyUI 位置、模型、远程 GPU、AI 改写用的大模型接口 |

## 需要什么

- Windows 10 / 11
- 出片的地方二选一：
  - **本机**：NVIDIA 显卡，建议 16GB 显存以上，硬盘留 100GB；
  - **远程**：一台租的云 GPU（建议 RTX 4090 24GB），本机只运行软件。
- 本机出片需要 [ComfyUI 便携版](https://github.com/comfyanonymous/ComfyUI/releases) v0.37.0
- [Node.js](https://nodejs.org/) 20 以上（从源码运行时需要）

## 安装

使用 AutoDL 时，只需在 Windows 完成第 3 步，再按[云端配置说明](docs/AutoDL配置.md)操作。本机出片按下面三步安装。

1. **ComfyUI 插件**：把 [`comfyui-plugins/`](comfyui-plugins/) 下的插件文件夹复制到 ComfyUI 的 `custom_nodes/`，详见那里的说明。
2. **模型**：按 [docs/模型下载.md](docs/模型下载.md) 下载，放到 ComfyUI 的 `models/` 下对应的位置。
3. **软件**：

   ```bash
   npm install
   npm run build
   ```

   之后双击 `启动器.bat` 打开。本机出片时，在 设置 → 常规 里选择 ComfyUI 便携版文件夹。

## 工作流

`workflow-templates/` 里是软件自带的工作流：

| 模板 | 用途 |
|---|---|
| `minimax-h3-wenwu-cont` | 文武双全 · 参考图生视频 · 接续版（推荐） |
| `minimax-h3-wenwu` | 文武双全 · 参考图生视频 |
| `minimax-h3-hybrid` | Hybrid · 参考图生视频 |
| `h3-ref2va` | Ref2VA · 参考图生视频 |
| `qwen-image-t2i` / `qwen-image-i2i` | Qwen-Image 2.1 文生图 / 图生图（素材页用） |
| `seedvr2-upscale` | SeedVR2 超分放大 |

## 开发

```bash
npm test              # 单元测试
npm run typecheck     # 界面的类型检查
npm run dev:ui        # 只调界面
```

## 内容说明

本项目只用于正常的影视创作。仓库里不包含、也不提供任何成人向的模型、LoRA 或提示词。

## 许可证

本项目以 [GNU 通用公共许可证 第 3 版（GPL-3.0）](LICENSE) 发布：可以自由使用、修改和再发布，但再发布修改后的版本时，也必须以 GPL-3.0 公开源代码。

`comfyui-plugins/` 里的插件和工作流用到的模型不属于本项目，各自遵循原作者的许可证。

## 致谢

MiniMax H3、Qwen-Image 2.1、SeedVR2 等模型以及 `comfyui-plugins/` 里的各个插件，版权归各自的作者，详见各自的许可证。
