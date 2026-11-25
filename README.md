# 黑箱剧场 BlackBox Theater

用 AI 做短剧的 Windows 桌面软件：写剧本、做人物和场景素材、按镜头出视频、挑片、连起来看。出片用的是 [ComfyUI](https://github.com/comfyanonymous/ComfyUI) 加 MiniMax H3 视频模型，可以在本机显卡上跑，也可以放到租的云 GPU（比如 AutoDL）上跑。

> Windows x64 提供独立安装包，内置桌面运行时和 SSH 客户端。首次启动会打开 AutoDL 和 DeepSeek 配置向导；之后右侧的「使用指南」从准备显卡、写剧本、拆分镜一直带到出片和关机，左侧「指南」可以随时收起或打开。没用过云服务器也没关系：AutoDL 的注册、充值、租实例、无卡模式等每一步都配了截图，红圈序号和文字一一对应。

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
- 从源码运行或构建安装包的开发者需要 Node.js 22.12 或更高版本。

## 安装

### Windows 独立安装包

从[最新发布页](https://github.com/ZiliCai/Black-theatre-open/releases/latest)下载 `BlackBox-Theater-Setup-<版本>-x64.exe`，双击安装。安装程序会安装到当前用户，并创建桌面和开始菜单快捷方式。安装结束后软件自动打开。第一次打开会进入配置向导，可以连接 AutoDL 和 DeepSeek，也可以选择用本机显卡，详见[云端配置说明](docs/AutoDL配置.md)。选择「稍后再说」后，可在「设置 → 远程 GPU」点「连接 AutoDL 实例」重新打开向导。整套模型约 66 GiB，可以先让实例以 AutoDL「无卡模式」开机，只下载模型，再换有卡模式验收，详见[先用无卡模式下载模型](docs/AutoDL配置.md#先用无卡模式下载模型省钱)。

云端模型在一键配置时下载到自己的 GPU 实例。希望在本机出片的用户，可在向导里选择「稍后配置」，准备 ComfyUI 便携版，按 [插件说明](comfyui-plugins/) 和 [模型说明](docs/模型下载.md) 安装，然后在「设置 → 常规」选择便携版文件夹。

### 从源码运行或制作安装包

开发者在源码目录执行 `npm ci`。用 `npm start` 构建并启动软件。在 Windows x64 执行 `npm run dist:win` 可生成独立安装包，文件保存在 `release/`。首次构建需要联网获取打包工具和经过 SHA-256 校验的 OpenSSH 客户端。

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
