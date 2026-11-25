import type { PageId, SettingsTab } from './context';

// The in-app guide: from a fresh installation to a finished episode. Names in 「」 are the
// labels the user will see on screen, so keep them in step with the pages they point to.
export type GuideStep = {
  id: string;
  title: string;
  goal: string;
  items: string[];
  tip?: string;
  optional?: boolean;
  go?: { page: PageId; tab?: SettingsTab; label: string };
  open?: { site: 'instance' | 'deepseek'; label: string };
};

export const GUIDE: GuideStep[] = [
  {
    id: 'gpu', title: '准备出片的显卡',
    goal: '画面和视频在 GPU 上生成。没有 16GB 以上显存的 NVIDIA 显卡，就租一台 AutoDL 云 GPU。',
    items: [
      '在 AutoDL 租一台实例，建议 RTX 4090 24GB，数据盘留 100 GB。',
      '到「设置 → 远程 GPU」点「连接 AutoDL 实例」，粘贴 SSH 登录指令和实例密码，一路点到「开始配置并自检」。',
      '省钱做法：实例先用「无卡模式开机」，勾选「无卡模式」只下载模型（约 66 GiB，一两个小时）。看到「模型已就绪」后关机，改用有卡模式开机，点「重新配置…」取消勾选，再点「配置并验收」。',
      '「云端配置」显示「可以使用」并出现验收图，这一步就完成了。',
    ],
    tip: '用自己电脑的显卡：到「设置 → 常规」选择 ComfyUI 便携版文件夹，插件和模型见项目说明。',
    go: { page: 'settings', tab: 'remote', label: '打开远程 GPU' },
    open: { site: 'instance', label: 'AutoDL 控制台' },
  },
  {
    id: 'ai', title: '连接 DeepSeek',
    goal: '剧本讨论、拆分镜和各页的「AI 改写」都用它，按用量计费。',
    items: [
      '在 DeepSeek 开放平台创建 API Key。配置向导里填过的话，这一步已经完成。',
      '到「设置 → 常规」的「DeepSeek / 大模型」，接口地址填 https://api.deepseek.com，填入 API 密钥，点「测试连接」。',
    ],
    go: { page: 'settings', tab: 'general', label: '打开常规设置' },
    open: { site: 'deepseek', label: '创建 API Key' },
  },
  {
    id: 'project', title: '新建剧本项目',
    goal: '一部剧一个项目文件夹，剧本、素材和生成的视频都放在里面。',
    items: [
      '在「设置 → 项目」点「新建项目」，写好剧本名，点「创建」。',
      '已经有剧本文件夹的，用「导入已有文件夹…」，里面原有的文件不会被改动。',
      '以后在顶栏右边的「项目」里切换。',
    ],
    go: { page: 'settings', tab: 'projects', label: '打开项目设置' },
  },
  {
    id: 'script', title: '写剧本',
    goal: '先把故事写清楚：大纲、人物设定和每集的剧情。',
    items: [
      '在「剧本」页点「新建文档」，写好后点「保存」。每次保存都会留下历史版本，随时可以恢复。',
      '点「AI 讨论」和 AI 聊人物、情节和节奏。说定怎么改后，它给出的修改逐条点「应用」写进文档。',
    ],
    go: { page: 'script', label: '去剧本页' },
  },
  {
    id: 'breakdown', title: '拆分镜',
    goal: '把整份剧本拆成一个个镜头，并写好每一镜的视频提示词。',
    items: [
      '在「剧本」页点「拆分镜」，选拆粗一点、正常或拆细一点，点「开始拆分」。AI 会列出人物、场景和每集的镜头。',
      '检查清单：改标题、时长和剧情，删掉或补上镜头，然后点「写提示词」。',
      '写好的镜头放在「分镜」文件夹，每集一篇；人物和场景放在「人物与场景（AI 拆分）」。',
    ],
    go: { page: 'script', label: '去剧本页' },
  },
  {
    id: 'assets', title: '给人物和场景出图',
    goal: '定妆图和场景图是出片时的参考，人物在每一镜里才长得一样。',
    items: [
      '在「素材」页左边选一张人物或场景卡，在右边写「想要什么样的图」，点「生成」。',
      '满意的图点「加入参考图」，最好的一张「设为主图」。镜头会自动挂上用到的素材卡。',
      '想微调就改用「图生图」在已有的图上改，或用「AI 改写」直接说大白话，比如“让他稍微帅一点”。',
    ],
    go: { page: 'assets', label: '去素材页' },
  },
  {
    id: 'scene', title: '搭场景白模', optional: true,
    goal: '用方块搭出建筑、门窗和家具，再排好人物站位和机位，提示词里的左右、远近就不会乱。',
    items: [
      '在「场景」页点「新建场景」，选「按设定文档搭」，让 AI 先搭一版，再看右边查出来的问题。',
      '「AI 排站位」按镜头排人和机位。每个机位的截图可以当场景底图，用在素材页的「图生图」里。',
    ],
    go: { page: 'scene', label: '去场景页' },
  },
  {
    id: 'shots', title: '逐镜出片',
    goal: '每个镜头生成几版视频，挑出最好的一版。',
    items: [
      '在「镜头」页左边选集和镜头，在右边检查提示词和参考图。',
      '设好「数量」，点「生成」。生成好后在下方的版本里挑最好的一条，点「选中」。',
      '不满意就用「AI 改写」说哪里要改，再生成。用「文武双全 · 接续版」时，下一镜会接着上一镜选中的那一版拍。',
    ],
    tip: '在云端出片时保持实例开机。排队和进度显示在顶栏右边。',
    go: { page: 'shots', label: '去镜头页' },
  },
  {
    id: 'review', title: '连起来看，超分定稿',
    goal: '按顺序看整集，满意后放大成高清。',
    items: [
      '在「镜头」页底部点「连起来看」，按顺序播放每一镜选中的版本。',
      '定稿后在底部「超分到」选清晰度，点「超分本集」，一次放大整集选中的版本。',
      '「成片」页能看所有生成过的图片和视频，点「在文件夹中显示」找到文件。',
    ],
    go: { page: 'shots', label: '去镜头页' },
  },
  {
    id: 'off', title: '用完关机',
    goal: '云 GPU 按开机时长计费，不用的时候记得关。',
    items: [
      '到 AutoDL 控制台关机。环境、模型和进度都在数据盘上，下次开机直接接着用。',
      '下次开机后回到软件，在顶栏的 ComfyUI 菜单点「重新连接服务器」或「启动服务器上的 ComfyUI」。',
    ],
    open: { site: 'instance', label: 'AutoDL 控制台' },
  },
];
