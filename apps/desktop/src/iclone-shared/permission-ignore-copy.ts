/**
 * V3-F (critic F-17) — the words of the Ignore permissions second confirm. Main shows them on a NATIVE dialog (a
 * compromised window cannot click it or steal its focus), so they live here, where main can read them; the six
 * locales match the app catalogues. The dialog lists exactly what the mode lifts.
 */

import { catalogueLocaleFor } from './offered-locale'

interface IgnoreConfirmCopy {
  title: string
  lead: string
  lifts: readonly string[]
  still: string
  confirm: string
  cancel: string
}

const COPY: Readonly<Record<string, IgnoreConfirmCopy>> = {
  en: {
    title: 'Ignore permissions for this project?',
    lead: 'Your agent will stop asking before it:',
    lifts: [
      'writes or deletes files in the project',
      'writes files outside the project',
      'runs commands',
      'uses the network',
      'sends messages',
      'installs software that needs no administrator password'
    ],
    still:
      'It still asks before it spends money or requests a system permission, and it never does what iclone os refuses in every mode.',
    confirm: 'Ignore permissions',
    cancel: 'Keep the current mode'
  },
  ar: {
    title: 'تجاهل الأذونات في هذا المشروع؟',
    lead: 'سيتوقف وكيلك عن السؤال قبل أن:',
    lifts: [
      'يكتب ملفات المشروع أو يحذفها',
      'يكتب ملفات خارج المشروع',
      'يشغّل الأوامر',
      'يستخدم الشبكة',
      'يرسل الرسائل',
      'يثبّت برامج لا تحتاج كلمة مرور المسؤول'
    ],
    still: 'سيظل يسأل قبل إنفاق المال أو طلب إذن من النظام، ولن يفعل أبدًا ما يرفضه iclone os في كل الأوضاع.',
    confirm: 'تجاهل الأذونات',
    cancel: 'الإبقاء على الوضع الحالي'
  },
  ja: {
    title: 'このプロジェクトで権限を無視しますか？',
    lead: 'エージェントは次の操作の前に確認しなくなります:',
    lifts: [
      'プロジェクト内のファイルの書き込みと削除',
      'プロジェクト外のファイルへの書き込み',
      'コマンドの実行',
      'ネットワークの利用',
      'メッセージの送信',
      '管理者パスワードが不要なソフトウェアのインストール'
    ],
    still:
      'お金の支払いやシステム権限の要求の前には引き続き確認し、iclone os がどのモードでも拒否することは決して行いません。',
    confirm: '権限を無視',
    cancel: '現在のモードのままにする'
  },
  zh: {
    title: '在此项目中忽略权限？',
    lead: '智能体在以下操作前将不再询问：',
    lifts: [
      '写入或删除项目内的文件',
      '写入项目外的文件',
      '运行命令',
      '使用网络',
      '发送消息',
      '安装无需管理员密码的软件'
    ],
    still: '它在花钱或申请系统权限前仍会询问，并且永远不会做 iclone os 在任何模式下都拒绝的事。',
    confirm: '忽略权限',
    cancel: '保持当前模式'
  },
  'zh-hant': {
    title: '在此專案中忽略權限？',
    lead: '代理在以下操作前將不再詢問：',
    lifts: [
      '寫入或刪除專案內的檔案',
      '寫入專案外的檔案',
      '執行指令',
      '使用網路',
      '傳送訊息',
      '安裝不需要管理者密碼的軟體'
    ],
    still: '它在花錢或申請系統權限前仍會詢問，而且永遠不會做 iclone os 在任何模式下都拒絕的事。',
    confirm: '忽略權限',
    cancel: '保持目前的模式'
  },
  // European Portuguese, keyed by the language subtag Electron reports (pt-PT, pt-BR and plain pt all read it).
  pt: {
    title: 'Ignorar permissões neste projeto?',
    lead: 'O seu agente deixa de perguntar antes de:',
    lifts: [
      'escrever ou eliminar ficheiros no projeto',
      'escrever ficheiros fora do projeto',
      'executar comandos',
      'usar a rede',
      'enviar mensagens',
      'instalar software que não precisa da palavra-passe de administrador'
    ],
    still:
      'Continua a perguntar antes de gastar dinheiro ou pedir uma permissão do sistema, e nunca faz o que o iclone os recusa em todos os modos.',
    confirm: 'Ignorar permissões',
    cancel: 'Manter o modo atual'
  }
}

/** The copy for a locale tag's catalogue language (`catalogueLocaleFor`); main passes `MAIN_DIALOG_LOCALE` (ruling 69). */
export function ignoreConfirmCopy(locale: string): IgnoreConfirmCopy {
  return catalogueLocaleFor(locale) === 'pt-PT' ? COPY.pt : COPY.en
}
