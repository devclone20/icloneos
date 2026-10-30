// iclone os — V3-G 隔离：程序坞的“容器”面板（简体中文）。
import type { ConfinementCopy } from '../en/confinement'

export const confinement: ConfinementCopy = {
  title: '容器',
  tile: '容器',
  unavailable: '容器在桌面应用中运行，你的智能体也在那里执行命令。',
  loading: '正在读取这台 Mac 上运行的内容…',
  verdict: {
    green: {
      label: '已隔离',
      hint: '每条智能体命令都在其配置文件内运行。隔离期间，MCP 服务器、计划任务的脚本、插件/技能/软件包的安装、电脑操控、编辑前的文件副本、编辑后的代码检查、委派工作的副本和你的钩子均关闭；选择“这台 Mac”可恢复。'
    },
    red: { label: '未隔离', hint: '隔离未经验证。原因见下方。' },
    off: {
      label: '已关闭',
      hint: '你选择了“这台 Mac”：智能体命令不受隔离，MCP 服务器、计划任务的脚本、安装、电脑操控、编辑前的文件副本、编辑后的代码检查、委派工作的副本和你的钩子会重新运行。'
    }
  },
  tabs: { live: '实时', agents: '智能体', profiles: '配置文件', refusals: '拒绝记录', backends: '后端' },
  inside: '隔离内',
  outside: '隔离外',
  col: { pid: 'PID', profile: '配置文件', session: '会话', time: '时长', command: '命令', kind: '类型' },
  kinds: { hermes: 'Hermes', 'agent-command': '智能体命令，未隔离', tool: '工具（MCP 服务器、辅助程序）' },
  kill: '终止',
  killTip: pid => `停止 ${pid} 及其启动的所有进程`,
  killed: count => `已停止 ${count} 个进程`,
  killFailed: {
    survivors: count => `有 ${count} 个进程无法停止`,
    unverified: () => '已停止能看到的部分，但无法向 macOS 确认是否还有残留',
    'not-confined': () => '不是受隔离的进程：未停止任何内容',
    invalid: () => '不是进程：未停止任何内容'
  },
  why: '原因',
  follow: '跟随',
  following: pid => `正在跟随 ${pid}`,
  stopFollowing: '停止跟随',
  empty: {
    inside: '没有正在运行的智能体命令。',
    outside: '没有智能体内容在隔离外运行。',
    agents: '暂无智能体活动。',
    refusals: '暂无拒绝记录。'
  },
  scope:
    '已隔离：终端、代码执行、文件工具，以及 Hermes 运行的浏览器和媒体处理，均在同一沙盒内。隔离期间关闭：MCP 服务器、计划任务的脚本、插件/技能/软件包的安装、电脑操控、从钥匙串导入，以及本地语音识别命令。',
  backendName: { seatbelt: 'Seatbelt（macOS）', container: 'Apple container' },
  backendStatus: {
    ready: '就绪',
    'not-installed': '未安装',
    installed: '已安装',
    unsupported: '此 Mac 不支持',
    broken: '无法工作',
    unknown: '无法检查'
  },
  active: '当前使用',
  network: { grant: '仅在授权后联网', never: '从不联网' },
  reads: '可读',
  writes: '可写',
  never: count => `始终禁止：${count} 个密钥与应用路径、钥匙串`,
  classes: {
    research: { name: '研究', summary: '读取项目，只写入其临时目录。' },
    project: { name: '项目', summary: '写入项目及其临时目录。' },
    build: { name: '构建', summary: '项目加上软件包缓存。' },
    offline: { name: '离线', summary: '项目，从不联网。' },
    media: { name: '媒体', summary: '读取输入，只写入一个输出文件夹。' }
  },
  defaultClass: name => `默认：${name}`,
  refusal: { operation: '被拒绝', target: '目标', process: '进程' },
  unattributed: '未归属',
  noSession: '无会话',
  insideCount: count => `隔离内 ${count}`,
  outsideCount: count => `隔离外 ${count}`,
  elapsed: seconds =>
    seconds < 60
      ? `${seconds} 秒`
      : seconds < 3600
        ? `${Math.floor(seconds / 60)} 分`
        : `${Math.floor(seconds / 3600)} 小时`,
  reasons: '变红的原因',
  reason: {
    'backend-not-confining': ({ backend, detail }) =>
      backend === 'container'
        ? 'Apple container 尚未提供隔离'
        : detail === 'probe-timeout'
          ? '未能及时检查 Seatbelt：目前无法确认隔离是否生效'
          : detail === 'probe-failed'
            ? '无法检查 Seatbelt：检查本身失败了，因此目前无法确认隔离是否生效'
            : 'Seatbelt 在这台 Mac 上没有起到隔离作用',
    'plugin-not-loaded': () => 'Shell 已阻止：隔离未加载。在它加载之前，你的智能体命令都会被拒绝。',
    'profile-changed': ({ cls }) => `${cls} 配置文件在磁盘上被修改了`,
    'widened-profile': ({ pid }) => `进程 ${pid} 在被放宽的配置文件下运行`,
    'unknown-profile': ({ pid }) => `进程 ${pid} 在并非本应用生成的配置文件下运行`,
    'agent-command-outside': ({ pid }) => `智能体命令 ${pid} 在隔离之外运行`,
    'forged-marker': ({ pid }) => `进程 ${pid} 声称已被隔离，但 macOS 表示并没有`,
    'membership-unverified': () => '无法向 macOS 查询哪些进程受隔离：脱离进程树的进程可能未被计入',
    'hardlink-appeared': ({ path, pid, root }) =>
      `运行 ${pid} 期间，${root} 中出现了指向项目外文件的硬链接（${path}）：只能在运行结束后发现，该次运行可能已访问到它；在你允许之前，那里的下一次运行将被拒绝`,
    'settings-ignored': () => '磁盘上的隔离设置文件未经本应用签名，已被忽略：隔离按默认设置保持开启'
  },
  notes: '注意',
  backendDetail: {
    enforcing: '正在生效：对照配置文件拒绝了测试文件。',
    'not-enforcing': '可以运行但没有生效：对照配置文件没有拒绝测试文件。',
    'cannot-run': '无法运行配置文件。',
    'binary-missing': '缺少 sandbox-exec：无法隔离任何内容。',
    'macos-only': 'Seatbelt 仅存在于 macOS。',
    'needs-apple-silicon': 'Apple container 需要 Apple 芯片和 macOS 26 或更高版本。',
    'no-version': '已安装，但没有响应版本检查：安装似乎已损坏。',
    'not-installed': '未安装。安装由你完成，需要输入一次管理员密码：',
    'not-wired': '此版本不使用：icloneOS 只用 Seatbelt 隔离命令。',
    'probe-failed': '检查本身失败了。',
    'probe-timeout': '检查未能及时完成：这台 Mac 当时可能很忙。稍后会再次检查。'
  },
  hardlinks: {
    blocked: (root, paths, count) =>
      `隔离不会在 ${root} 中启动：${paths.join('、')}${count > paths.length ? ` 等 ${count} 个文件` : ''}是指向项目外文件的硬链接，请删除它们或在下方按文件夹允许。`,
    cannotScan: (root, paths, count) =>
      `隔离不会在 ${root} 中启动：无法列出 ${paths.join('、')}${count > paths.length ? ` 等 ${count} 个文件夹` : ''}，硬链接可能藏在其中，请给这些文件夹读取权限（chmod u+rx）。`,
    group: (dir, count) => `${dir} 下的 ${count} 个文件 — 指向项目外的硬链接`,
    allow: count => (count === 1 ? '允许此文件' : `允许 ${count} 个文件`),
    allowTip: '命令可以读写这些文件的当前版本，并由此读写它们所链接的项目外文件；新的链接会再次询问',
    allowed: count => `已允许：这 ${count} 个文件的当前版本`,
    ackFailed: {
      'no-gesture': '未允许：请亲自点击按钮',
      'not-in-project': '未允许：该文件夹不在这个项目中',
      'nothing-to-allow': '无需允许：该文件夹下已没有硬链接',
      changed: '未允许：该文件夹下的文件在显示后发生了变化，请重新读取',
      invalid: '未允许：该文件夹已不存在'
    },
    cachesUnscanned: '软件包缓存（npm、pip、cargo、pnpm…）不扫描硬链接：Build 命令本来就可以读写它们。'
  }
}
