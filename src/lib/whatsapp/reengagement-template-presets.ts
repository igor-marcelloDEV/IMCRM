import type { TemplateButton } from '@/types';

export interface ReengagementTemplatePreset {
  id: string;
  name: string;
  title: string;
  description: string;
  bodyText: string;
  bodySamples: string[];
  footerText: string;
  buttons: TemplateButton[];
}

const CONTINUE_OR_CLOSE_BUTTONS: TemplateButton[] = [
  { type: 'QUICK_REPLY', text: 'Continuar atendimento' },
  { type: 'QUICK_REPLY', text: 'Encerrar atendimento' },
];

export const REENGAGEMENT_TEMPLATE_PRESETS: ReengagementTemplatePreset[] = [
  {
    id: 'retomar_atendimento',
    name: 'retomar_atendimento',
    title: 'Retomar atendimento',
    description: 'Uma abordagem direta e cordial para reabrir a conversa.',
    bodyText:
      'Olá, {{1}}! Gostaríamos de confirmar se você ainda deseja continuar nosso atendimento. Estamos à disposição para ajudar. Como prefere seguir?',
    bodySamples: ['Maria'],
    footerText: 'Escolha uma das opções abaixo.',
    buttons: CONTINUE_OR_CLOSE_BUTTONS,
  },
  {
    id: 'acompanhamento_atendimento',
    name: 'acompanhamento_atendimento',
    title: 'Acompanhamento amigável',
    description:
      'Um contato mais leve para saber se a pessoa ainda precisa de ajuda.',
    bodyText:
      'Oi, {{1}}! Tudo bem? Passamos para saber se você ainda precisa da nossa ajuda com o atendimento iniciado anteriormente. Podemos continuar por aqui?',
    bodySamples: ['Maria'],
    footerText: 'Responda usando uma das opções abaixo.',
    buttons: CONTINUE_OR_CLOSE_BUTTONS,
  },
  {
    id: 'ultima_tentativa_atendimento',
    name: 'ultima_tentativa_atendimento',
    title: 'Última tentativa',
    description:
      'Uma mensagem respeitosa antes de encerrar um contato sem resposta.',
    bodyText:
      'Olá, {{1}}! Este é nosso último contato sobre seu atendimento. Se ainda precisar de ajuda, podemos retomar a conversa. Caso contrário, encerraremos o atendimento por enquanto.',
    bodySamples: ['Maria'],
    footerText: 'Você poderá falar conosco novamente quando precisar.',
    buttons: CONTINUE_OR_CLOSE_BUTTONS,
  },
];

export function getReengagementTemplatePreset(id: string | null) {
  return REENGAGEMENT_TEMPLATE_PRESETS.find((preset) => preset.id === id);
}
