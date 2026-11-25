import type { CloudLink } from '../api';
import type { PageId, SettingsTab } from './context';

// The in-app guide, written for people who have never rented a server or used a command line.
// Names in 「」 are labels the user will see on screen (in this app or on the website the step
// opens), so keep them in step with the pages they point to. [1] [2] … are the red numbers in
// the screenshot that follows the sentence (ui/src/assets/guide; numbering restarts per picture).
export type Route = 'cloud' | 'local';
// A sentence, or a screenshot by its file name without the extension.
export type GuideItem = string | { img: string; alt: string };
export type GuideStep = {
  id: string;
  part: string;
  title: string;
  goal: string;
  items: GuideItem[];
  tip?: string;
  warn?: string;
  optional?: boolean;
  route?: Route;
  go?: { page: PageId; tab?: SettingsTab; label: string };
  links?: { site: CloudLink; label: string }[];
};

const RENT = '一、租一台云 GPU';
const LOCAL = '一、准备自己的电脑';
const CONNECT = '二、把软件连上显卡';
const MAKE = '三、做一部短剧';
const AFTER = '四、用完以后';

export const GUIDE: GuideStep[] = [
  // ---- AutoDL, from no account to a running instance ----
  {
    id: 'autodl-account', part: RENT, route: 'cloud', title: '注册 AutoDL 账号',
    goal: '画面和视频要用很强的显卡来算。AutoDL 是按小时出租显卡的网站，用多久付多久，不用自己买显卡。',
    items: [
      '点下面的「打开 AutoDL 官网」，在网页右上角点 [1]「立即注册」。',
      { img: 'autodl-signup-entry', alt: 'AutoDL 首页右上角的立即注册按钮' },
      '在注册页依次：[1] 填手机号 → [2] 点「发送验证码」→ [3] 填手机收到的验证码 → [4] 设置登录密码（8～16 位，要同时有数字和字母）→ [5] 确认勾选同意协议 → [6] 点「注册」。',
      { img: 'autodl-signup-form', alt: 'AutoDL 注册表单' },
      '注册好就是登录状态。实名认证不是必须的，不认证也能租显卡。',
    ],
    tip: '这些网页都在电脑自带的浏览器里打开，和黑箱剧场互不影响。办完一步回到这里继续看。点截图可以放大。',
    links: [{ site: 'autodl', label: '打开 AutoDL 官网' }],
  },
  {
    id: 'autodl-money', part: RENT, route: 'cloud', title: '给 AutoDL 充值',
    goal: '租显卡从账户余额里扣钱，先充一点进去。',
    items: [
      '点网页右上角的「控制台」，在首页右边的「费用信息」里点 [1]「去充值」。',
      { img: 'autodl-topup-entry', alt: '控制台首页的去充值按钮' },
      '[1] 选充值金额，第一次选 ¥50 就够下载模型并试做几段视频 → [2] 选微信支付或支付宝 → [3] 点「充值」，用手机扫码付款。',
      { img: 'autodl-topup-page', alt: 'AutoDL 充值页' },
      '大概花多少：RTX 4090 每小时两块钱左右（以租用页显示为准）；「无卡模式」0.1 元/小时；数据盘扩容 50GB 每天约 0.35 元，开不开机都收。',
    ],
    warn: '余额用完后实例会停下来，欠费太多平台可能会清掉数据。余额不多时记得及时充值。',
    links: [{ site: 'recharge', label: '打开充值页' }],
  },
  {
    id: 'autodl-rent', part: RENT, route: 'cloud', title: '租实例：选显卡',
    goal: '“实例”就是你租下的那台云电脑。租用页有好几项要选，分三步来。',
    items: [
      '在控制台左边点 [1]「容器实例」，再点 [2]「租用新实例」。',
      { img: 'autodl-console-rent', alt: '容器实例页的租用新实例按钮' },
      '[1] 计费方式选「按量计费」→ [2] 选一个地区 → [3] GPU 型号勾选「RTX 4090」→ [4] GPU 数量选「1」。',
      { img: 'autodl-rent-gpu', alt: '租用页的计费方式、地区、GPU 型号和数量' },
      'RTX 4090 后面括号里是「空闲/总数」，比如图里的 (1/1696) 表示还有 1 张能租。第一个数字是 0，就换一个地区再看。',
      '各地区的 RTX 4090 都没有空卡时，可以勾选「vGPU-48GB」：它其实是 48GB 显存的 RTX 4090，每小时贵一块钱左右（约 3 元），一样能用。',
    ],
    links: [{ site: 'instance', label: '打开 AutoDL 控制台' }],
  },
  {
    id: 'autodl-host', part: RENT, route: 'cloud', title: '租实例：挑一台主机',
    goal: '同一种显卡有很多台主机，挑一台条件都满足的。',
    items: [
      '往下翻到「选择主机」，找一台同时满足三条的：[1] 空闲 GPU 的第一个数字大于 0；[2] 可扩容至少 50GB；[3] CUDA 是 12.8 或更高。然后 [4] 点这一行最左边的圆圈选中它。',
      { img: 'autodl-rent-host', alt: '主机列表：空闲 GPU、可扩容和 CUDA 版本' },
      '图里上面那台就不行：可扩容是 0GB，CUDA 只有 12.6。',
    ],
  },
  {
    id: 'autodl-create', part: RENT, route: 'cloud', title: '租实例：硬盘、镜像，创建',
    goal: '数据盘要放 66 GiB 的模型，得扩容；镜像决定实例里预装什么软件。',
    items: [
      '再往下：[1] 数据盘勾选「需要扩容」→ [2] 填 50（加上免费的 50GB，一共 100GB）。',
      '[3] 镜像选「基础镜像」→ [4] 点下拉框，依次选 PyTorch → 2.8.0 → 3.12(ubuntu22.04) → 12.8。',
      '最后看一眼底部的费用，点 [5]「创建并开机」。',
      { img: 'autodl-rent-disk-image', alt: '数据盘扩容、镜像选择和创建并开机按钮' },
    ],
    warn: '实例一创建就开机计费。按下一步马上换成便宜的「无卡模式」再下载模型。',
  },
  {
    id: 'autodl-nogpu', part: RENT, route: 'cloud', title: '换成无卡模式开机',
    goal: '模型有 66 GiB，要下载一两个小时。下载用不到显卡，无卡模式只要 0.1 元/小时。',
    items: [
      '回到「容器实例」，点这台实例右边的 [1]「关机」。',
      { img: 'autodl-shutdown', alt: '实例列表里的关机按钮' },
      '等状态变成「已关机」，把鼠标移到 [1]「更多」上，在弹出的菜单里点 [2]「无卡模式开机」。等状态变回「运行中」。',
      { img: 'autodl-nogpu-boot', alt: '更多菜单里的无卡模式开机' },
    ],
    tip: '一个账号同一时间只能有一台无卡模式的实例。',
    links: [{ site: 'instance', label: '打开 AutoDL 控制台' }],
  },
  {
    id: 'autodl-login', part: RENT, route: 'cloud', title: '复制登录指令和密码',
    goal: '软件要用这两样东西连上你的实例。',
    items: [
      '在「SSH 登录」那一栏：点 [1] 复制图标复制「登录指令」，点 [2] 复制图标复制「密码」。网页上显示成星号是正常的，复制出来的是完整内容。',
      { img: 'autodl-ssh-login', alt: 'SSH 登录一栏的两个复制图标' },
      '复制一样就到软件里粘贴一样（下一部分会讲），不用另外记下来。',
    ],
    warn: '登录指令和密码等于这台实例的钥匙，不要发给别人。',
    links: [{ site: 'instance', label: '打开 AutoDL 控制台' }],
  },

  // ---- Own graphics card ----
  {
    id: 'local-card', part: LOCAL, route: 'local', title: '确认显卡够用',
    goal: '要在自己电脑上出片，需要 NVIDIA 显卡，显存最好 16 GB 以上，硬盘留出 100 GB。',
    items: [
      '在 Windows 任务栏搜索「任务管理器」并打开，点「性能」，看「GPU」那一项的显卡型号和「专用 GPU 内存」。',
      '显存不到 16 GB 或者不是 NVIDIA 显卡，建议切换到上面的「云 GPU」路线。',
    ],
  },
  {
    id: 'local-comfy', part: LOCAL, route: 'local', title: '准备 ComfyUI 便携版',
    goal: 'ComfyUI 是真正负责出图出片的程序，黑箱剧场负责指挥它。',
    items: [
      '下载 ComfyUI 便携版 v0.37.0（Windows 版的 7z 压缩包），解压到空间充足的硬盘，例如 D:\\ComfyUI。',
      '按「插件说明」把需要的插件放进 ComfyUI 的 custom_nodes 文件夹。',
      '按「模型说明」把模型放进 ComfyUI 的 models 下对应的文件夹，有几个文件下载后要改名。',
      '到「设置 → 常规」，在「ComfyUI 便携版文件夹」点「选择…」，选中刚才解压的文件夹。',
    ],
    tip: '这一步对新手比较难。卡住的话，用「云 GPU」路线会省事很多。',
    go: { page: 'settings', tab: 'general', label: '打开常规设置' },
    links: [{ site: 'comfyui', label: '下载 ComfyUI' }, { site: 'pluginsDoc', label: '插件说明' }, { site: 'modelsDoc', label: '模型说明' }],
  },

  // ---- DeepSeek and the connection ----
  {
    id: 'ai', part: CONNECT, title: '注册 DeepSeek，拿到 API Key',
    goal: '写剧本时和你讨论、帮你拆分镜和改提示词的 AI 是 DeepSeek，按用量收费，一般一次只要几分钱。',
    items: [
      '点下面的「打开 DeepSeek 开放平台」，用手机号注册并登录。',
      '在平台里找到「充值」，先充 10 元左右就能用很久。',
      '点左边的「API keys」，再点「创建 API key」，名字随便写，比如“黑箱剧场”。',
      '复制以 sk- 开头的那串密钥。它只显示这一次，没复制到就删掉重新创建一个。',
      '用 AutoDL 的话，下一步连接时会让你粘贴它；用自己显卡的话，到「设置 → 常规」的「DeepSeek / 大模型」粘贴进「API 密钥」，点「测试连接」。',
    ],
    warn: 'API Key 和密码一样，不要发给别人。软件会把它加密保存在这台电脑上。',
    links: [{ site: 'deepseek', label: '打开 DeepSeek 开放平台' }],
  },
  {
    id: 'connect', part: CONNECT, route: 'cloud', title: '在软件里连接实例',
    goal: '把登录指令、密码和 DeepSeek 密钥交给软件，它会自己把出片环境装到你的实例上。',
    items: [
      '到「设置 → 远程 GPU」，点「连接 AutoDL 实例」。',
      '把复制的登录指令粘贴到「SSH 登录指令」，密码粘贴到「实例密码」。',
      '实例现在是无卡模式，勾选「实例以无卡模式开机：先只下载模型」，点「下一步」。',
      '粘贴 DeepSeek 的 API Key，点「下一步」，再点「开始下载模型」。',
    ],
    tip: '粘贴的方法：先点一下输入框，再按键盘上的 Ctrl 和 V。密码框里看不到字是正常的。',
    go: { page: 'settings', tab: 'remote', label: '打开远程 GPU' },
  },
  {
    id: 'download', part: CONNECT, route: 'cloud', title: '等模型下载完',
    goal: '下载在云上进行，关掉软件、电脑休眠都不影响。',
    items: [
      '在「设置 → 远程 GPU」的「云端配置」能看到下载进度、速度和预计完成时间，一般一两个小时。',
      '中途网络不好会自动重试。如果显示「已中断」，点「重新配置…」再点一次开始，已经下好的部分不会重下。',
      '看到「模型已就绪」就可以做下一步了。',
    ],
    go: { page: 'settings', tab: 'remote', label: '查看下载进度' },
  },
  {
    id: 'accept', part: CONNECT, route: 'cloud', title: '换有卡模式，验收一次',
    goal: '现在要用显卡了：换回正常开机，让软件试着出一张图和一段短视频，确认一切正常。',
    items: [
      '在 AutoDL「容器实例」里点「关机」，等变成「已关机」，再点 [1]「开机」。这次不要选「更多」里的无卡模式。',
      { img: 'autodl-gpu-boot', alt: '已关机实例的开机按钮' },
      '如果弹出「该主机空闲GPU不足」：按量计费的实例关机后，显卡会让给别人用，这台主机暂时没有空卡了。可以过一阵再试，也可以把实例“克隆”到另一台有空卡的主机上，模型跟着一起拷过去：',
      '把鼠标移到「更多」上，点「克隆实例」→ [1] 一定要勾选「数据盘」→ [2] 点「继续」。接下来和租新实例一样挑一台有空卡的主机，记得把数据盘也扩容 50GB，再创建。',
      { img: 'autodl-clone', alt: '克隆实例对话框：勾选数据盘后继续' },
      '克隆出来的是一台新实例，登录指令会变：在软件「远程 GPU」点「连接 AutoDL 实例」，用新的登录指令和密码重新连一次。原来那台不用了的话，在「更多」里释放它，就不会再收数据盘的钱。',
      '回到「设置 → 远程 GPU」，在「云端配置」点「重新配置…」，取消勾选「无卡模式：只下载模型」，点「配置并验收」。',
      '等十几分钟到半小时。看到「可以使用」和验收图，云 GPU 就准备好了。',
    ],
    tip: '如果开机后控制台里的登录指令变了，在「远程 GPU」点这台服务器的「修改」，换成新的。',
    go: { page: 'settings', tab: 'remote', label: '打开远程 GPU' },
    links: [{ site: 'instance', label: '打开 AutoDL 控制台' }],
  },

  // ---- Making the film ----
  {
    id: 'project', part: MAKE, title: '新建剧本项目',
    goal: '一部剧一个项目文件夹，剧本、图片和视频都放在里面。',
    items: [
      '到「设置 → 项目」，点「新建项目」，写好剧本名，点「创建」。',
      '已经有剧本文件夹的，用「导入已有文件夹…」，里面原有的文件不会被改动。',
      '以后在软件最上面一栏右边的「项目」里切换。',
    ],
    go: { page: 'settings', tab: 'projects', label: '打开项目设置' },
  },
  {
    id: 'script', part: MAKE, title: '写剧本',
    goal: '先把故事写清楚：大纲、人物设定和每集的剧情。',
    items: [
      '在「剧本」页点「新建文档」，起个名字，把剧本写进去或粘贴进去，点「保存」。',
      '点「AI 讨论」，像聊天一样问 AI，比如“第二场节奏太慢，怎么改？”。说定以后，它给出的修改逐条点「应用」写进文档。',
    ],
    tip: '每次保存都会留下旧版本，改坏了可以在「历史版本」里找回来。',
    go: { page: 'script', label: '去剧本页' },
  },
  {
    id: 'breakdown', part: MAKE, title: '拆分镜',
    goal: '把剧本拆成一个个镜头，并让 AI 写好每一镜的视频提示词。',
    items: [
      '在「剧本」页点「拆分镜」，选「拆粗一点」「正常」或「拆细一点」，点「开始拆分」。',
      'AI 列出人物、场景和每集的镜头。检查清单：改标题、时长和剧情，删掉或补上镜头。',
      '检查完点「写提示词」，等 AI 一镜一镜写完。',
    ],
    tip: '写好的镜头在「分镜」文件夹，每集一篇；人物和场景在「人物与场景（AI 拆分）」里。',
    go: { page: 'script', label: '去剧本页' },
  },
  {
    id: 'assets', part: MAKE, title: '给人物和场景出图',
    goal: '先给每个人物拍定妆照、给每个场景出图，视频里的人才会每一镜都长得一样。',
    items: [
      '在「素材」页左边点一张人物或场景卡，在右边「想要什么样的图」里用大白话写，比如“正面定妆，站在路边，全身”，点「生成」。',
      '满意的图点「加入参考图」，最好的一张点「设为主图」。拆分镜时用到这张卡的镜头会自动带上它。',
      '想微调：选「图生图」在已有的图上改，或者点「AI 改写」直接说哪里不满意，比如“让他稍微帅一点”。',
    ],
    go: { page: 'assets', label: '去素材页' },
  },
  {
    id: 'scene', part: MAKE, optional: true, title: '搭场景白模',
    goal: '用方块搭出房子、门窗和家具，排好人物站位和镜头位置，画面里的左右、远近就不会乱。',
    items: [
      '在「场景」页点「新建场景」，选「按设定文档搭」，让 AI 先搭一版，再看右边查出来的问题。',
      '「AI 排站位」按镜头排好人和机位。每个机位的截图可以当场景底图，用在素材页的「图生图」里。',
    ],
    go: { page: 'scene', label: '去场景页' },
  },
  {
    id: 'shots', part: MAKE, title: '一镜一镜出视频',
    goal: '每个镜头生成几版视频，挑出最好的一版。',
    items: [
      '在「镜头」页左边选好集和镜头，在右边检查提示词和参考图。',
      '在画面上方设好「数量」（一次出几版），点「生成」。进度显示在软件最上面一栏。',
      '生成好后在画面下方点每一版看看，挑最好的一条点「选中」。',
      '都不满意就点「AI 改写」说哪里要改，再生成。',
    ],
    tip: '用「文武双全 · 接续版」时，下一镜会接着上一镜选中的那一版拍，所以按顺序一镜一镜来。用云 GPU 时实例要保持开机。',
    go: { page: 'shots', label: '去镜头页' },
  },
  {
    id: 'review', part: MAKE, title: '连起来看，超分定稿',
    goal: '按顺序看完整集，满意后放大成高清。',
    items: [
      '在「镜头」页底部点「连起来看」，按顺序播放每一镜选中的版本。',
      '定稿后在底部「超分到」选清晰度，点「超分本集」，一次放大整集选中的版本。',
      '「成片」页能看所有生成过的图片和视频，点「在文件夹中显示」就能找到文件。',
    ],
    go: { page: 'shots', label: '去镜头页' },
  },

  // ---- Afterwards ----
  {
    id: 'off', part: AFTER, route: 'cloud', title: '用完马上关机',
    goal: '云 GPU 开着就一直计费，不出片的时候就关掉。',
    items: [
      '在 AutoDL「容器实例」点 [2]「关机」。软件、模型和做到一半的进度都存在数据盘上，关机不会丢。怕忘的话，可以用 [1]「设置定时关机」让它到点自己关。',
      { img: 'autodl-schedule-off', alt: '设置定时关机和关机按钮' },
      '下次用：先在 AutoDL 点「开机」，再打开黑箱剧场。如果软件顶部提示连不上，点最上面一栏的 ComfyUI 状态，选「重新连接服务器」或「启动服务器上的 ComfyUI」。',
    ],
    warn: '实例连续关机 15 天会被平台释放（关机后列表里会显示还剩几天），里面的东西全部清空，又得重新下载模型。长时间不用的话，隔十来天用「无卡模式开机」开一下再关掉，就会重新计算。',
    links: [{ site: 'instance', label: '打开 AutoDL 控制台' }],
  },
];
