# ComfyUI 插件

黑箱剧场的工作流要用到下面这些 ComfyUI 插件。把这个文件夹里的插件**整个文件夹**复制到 ComfyUI 的 `custom_nodes/` 下，然后重启 ComfyUI。插件自己需要的 Python 依赖，按各插件文件夹里的 `requirements.txt` 安装。

这些插件都是别人写的开源项目，版权归原作者，原样收录（只删掉了演示视频、示例图片和工作流用不到的附带目录）。各自的许可证在插件文件夹的 `LICENSE` 里。

| 插件 | 版本 | 许可证 | 原仓库 | 哪些工作流要用 |
|---|---|---|---|---|
| ComfyUI-GGUF | 2.0.0 | Apache-2.0 | [city96/ComfyUI-GGUF](https://github.com/city96/ComfyUI-GGUF) | Hybrid |
| ComfyUI-H3-Motion-Context | 0.3.0 | GPL-3.0 | [NikoDemon80/ComfyUI-H3-Motion-Context](https://github.com/NikoDemon80/ComfyUI-H3-Motion-Context) | 文武双全·接续版、Hybrid、Ref2VA |
| ComfyUI-H3-Multishot | — | MIT | RiftCast（原仓库已找不到） | Ref2VA |
| ComfyUI-MAINodes | 1.1.3 | GPL-3.0 | [matlowai/ComfyUI-MAINodes](https://github.com/matlowai/ComfyUI-MAINodes) | Hybrid |
| ComfyUI-SeedVR2_VideoUpscaler | 2.5.24 | Apache-2.0 | [numz/ComfyUI-SeedVR2_VideoUpscaler](https://github.com/numz/ComfyUI-SeedVR2_VideoUpscaler) | 超分 |
| ComfyUI-Dehypnotic | — | MIT | [Dehypnotic/ComfyUI-Dehypnotic](https://github.com/Dehypnotic/ComfyUI-Dehypnotic) | Ref2VA |
| comfyui-kjnodes | 1.5.0 | GPL-3.0 | [kijai/ComfyUI-KJNodes](https://github.com/kijai/ComfyUI-KJNodes) | 全部视频工作流 |
| comfyui-videohelpersuite | 1.7.9 | GPL-3.0 | [Kosinkadink/ComfyUI-VideoHelperSuite](https://github.com/Kosinkadink/ComfyUI-VideoHelperSuite) | 文武双全、Ref2VA、超分 |
| SelfLiftH3Sampler | — | 未声明 | 改自 [facok/comfyui-SelfLift](https://github.com/facok/comfyui-SelfLift)（H3 改版的原仓库已下线） | 文武双全（两个） |

## 关于 SelfLiftH3Sampler

它改自 [facok/comfyui-SelfLift](https://github.com/facok/comfyui-SelfLift)，加入了 MiniMax H3 的支持。原仓库没有声明开源许可证，H3 改版的仓库也已经下线，这里保留的是作者发布时的原样副本，版权归原作者。如果原作者不希望在这里分发，请提 issue，我们会删除。

## ComfyUI 版本

以上插件在 ComfyUI v0.37.0 上测试过。
