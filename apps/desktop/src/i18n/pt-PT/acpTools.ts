// iclone os — REL-6 as ferramentas ACP (pt-PT). O processo principal instala-as e verifica-as; estas palavras dizem o
// que ele fez.
import type { AcpToolsTranslations } from '../types/acpTools'

export const acpTools: AcpToolsTranslations = {
  title: {
    checking: 'A verificar as ferramentas ACP…',
    absent: 'Ferramentas ACP não instaladas',
    stale: 'As ferramentas ACP precisam de atualização',
    installing: 'A instalar as ferramentas ACP…',
    unverified: 'Não foi possível verificar as ferramentas ACP',
    unavailable: 'Ferramentas ACP indisponíveis'
  },
  hint: 'O ACP Market e o Work executam a CLI ACP da Virtuals. Não faz parte do iclone os: é transferida do npm para a pasta da própria aplicação e verificada contra um lockfile fixado.',
  thirdParty: 'Os pacotes de terceiros são instalados a partir do npm, sob as suas próprias licenças.',
  thirdPartyLink: 'Avisos de terceiros',
  install: 'Instalar (transfere do npm)',
  update: 'Atualizar (transfere do npm)',
  reinstall: 'Reinstalar (transfere do npm)',
  cancel: 'Cancelar',
  progress: (done, total, megabytes) => `${done} de ${total} pacotes · ${megabytes} MB`,
  verifying: 'A verificar cada ficheiro…',
  installed: version => `Versão ${version} instalada · verificada`,
  reason: reason => `Motivo: ${reason}`,
  unavailable: reason => `Não podem ser instaladas aqui: ${reason}`,
  reasons: {
    'pin-invalid': 'a lista fixada de pacotes desta versão falta ou não confere',
    'launcher-missing': 'falta o iniciador desta versão',
    'installer-down': 'o instalador não está em execução',
    unsealable:
      'este sistema não consegue proteger o registo da instalação no porta-chaves, por isso nada pode ser verificado',
    'keychain-off':
      'a definição do Porta-chaves está desligada. Ligue o Porta-chaves em Definições › Máquina › Gateways › «Guardar as palavras-passe no porta-chaves do sistema» para instalar e usar as ferramentas ACP',
    'key-unopenable': 'não é possível abrir a chave da instalação no porta-chaves',
    'record-unwritable': 'não foi possível guardar o registo da instalação',
    'manifest-missing': 'falta a lista dos ficheiros instalados',
    'manifest-malformed': 'a lista dos ficheiros instalados está danificada',
    'manifest-digest': 'a lista dos ficheiros instalados não confere',
    'manifest-signature': 'a lista dos ficheiros instalados não é a que esta aplicação assinou',
    'other-pin': 'foi instalada para outra versão desta aplicação',
    'not-recorded': 'esta aplicação não tem registo de a ter instalado',
    'tree-unreadable': 'não é possível ler os ficheiros instalados',
    'not-plain': 'a pasta instalada contém algo que não é um ficheiro simples',
    'extra-file': 'foi acrescentado um ficheiro à pasta instalada',
    'missing-file': 'falta um ficheiro na pasta instalada',
    'file-changed': 'um ficheiro instalado foi alterado',
    'mode-changed': 'as permissões de um ficheiro instalado foram alteradas',
    moved: 'a pasta instalada mudou enquanto estava a ser iniciada',
    'system-acp': 'esta aplicação nunca executa um acp encontrado noutro sítio deste computador',
    'download-failed': 'uma transferência do npm falhou',
    'download-stalled': 'uma transferência do npm deixou de enviar dados',
    'download-timeout': 'uma transferência do npm demorou demasiado',
    'download-too-large': 'uma transferência do npm excedeu o tamanho permitido',
    'download-refused': 'o npm respondeu a partir de outro endereço, que nunca é seguido',
    integrity: 'um pacote transferido não corresponde à sua impressão digital fixada',
    'tar-unsafe': 'um pacote transferido contém uma entrada insegura',
    'nested-modules': 'um pacote transferido traz os seus próprios pacotes, o que não é permitido',
    'licence-file-missing': 'um pacote indica um ficheiro de licença que não inclui',
    'signer-missing': 'o pacote da CLI não tem assinador para este sistema',
    'addons-missing': 'faltam os módulos nativos da própria aplicação',
    'addons-mismatch': 'os módulos nativos da aplicação não correspondem aos pacotes a instalar',
    'addon-swap': 'um módulo nativo desta aplicação não confere',
    'new-tree-unverified': 'os novos ficheiros não foram verificados, por isso nada foi substituído',
    disk: 'não foi possível gravar os ficheiros no disco',
    internal: 'ocorreu um erro inesperado'
  },
  withSubject: (reason, subject) => `${reason} (${subject})`,
  licences: 'Licenças dos pacotes instalados',
  errors: {
    gesture: 'Isto precisa do seu próprio clique.',
    busy: 'Já está a decorrer uma instalação.',
    audit: 'O registo de permissões não está disponível, por isso nada foi instalado.',
    cancelled: 'Instalação cancelada. Nada foi instalado.',
    failed: detail => `A instalação falhou: ${detail}`
  }
}
