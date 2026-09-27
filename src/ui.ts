import type { DeclarativeNode } from 'openfox/plugin'

export interface AntigravityAccountView {
  credentialRef: string
  email?: string
  status?: string
  priority?: number
}

export function buildDeclarativeAuthComponent(
  accounts: AntigravityAccountView[],
  settings: { routingStrategy?: string; roundRobinStickyLimit?: number },
  providerId?: string,
): DeclarativeNode {
  const accountCards: DeclarativeNode[] = accounts.map((acc, idx) => ({
    type: 'card',
    children: [
      {
        type: 'stack',
        direction: 'row',
        align: 'center',
        justify: 'between',
        children: [
          {
            type: 'stack',
            direction: 'column',
            gap: 'none',
            children: [
              {
                type: 'text',
                text: { en: acc.email || `Google Account ${idx + 1}`, fr: acc.email || `Compte Google ${idx + 1}` },
                className: 'font-semibold text-text-primary text-sm',
              },
              {
                type: 'text',
                text: {
                  en: acc.status === 'connected' ? 'Connected ✓' : 'Disconnected / Expired',
                  fr: acc.status === 'connected' ? 'Connecté ✓' : 'Déconnecté / Expiré',
                },
                className: acc.status === 'connected' ? 'text-xs text-accent-success font-medium' : 'text-xs text-text-muted',
              },
            ],
          },
          {
            type: 'button',
            label: { en: 'Remove', fr: 'Supprimer' },
            variant: 'danger',
            size: 'sm' as any,
            action: {
              kind: 'rpc',
              method: 'antigravity.removeAccount',
              params: { credentialRef: acc.credentialRef, providerId },
            },
            onActivate: {
              kind: 'rpc',
              method: 'antigravity.removeAccount',
              params: { credentialRef: acc.credentialRef, providerId },
            },
          },
        ],
      },
    ],
  }))

  return {
    type: 'stack',
    direction: 'column',
    gap: 'md',
    children: [
      {
        type: 'callout',
        tone: 'info',
        title: {
          en: 'Google Antigravity Multi-Account',
          fr: 'Multi-Comptes Google Antigravity',
        },
        text: {
          en: 'Connect one or multiple Google accounts. Requests will be automatically load balanced and routed according to your strategy.',
          fr: 'Connectez un ou plusieurs comptes Google. Les requêtes seront automatiquement réparties et routées selon votre stratégie.',
        },
      },
      {
        type: 'stack',
        direction: 'column',
        gap: 'sm',
        children: [
          {
            type: 'text',
            text: {
              en: `Connected Google Accounts (${accounts.length})`,
              fr: `Comptes Google connectés (${accounts.length})`,
            },
            className: 'font-semibold text-text-primary text-sm',
          },
          ...(accountCards.length > 0
            ? accountCards
            : [
                {
                  type: 'text' as const,
                  text: { en: 'No Google accounts connected yet.', fr: 'Aucun compte Google connecté pour le moment.' },
                  muted: true,
                  className: 'text-sm text-text-muted py-2',
                },
              ]),
        ],
      },
      {
        type: 'button',
        label: {
          en: accounts.length > 0 ? '+ Connect Another Google Account' : 'Connect Google Account',
          fr: accounts.length > 0 ? '+ Connecter un autre compte Google' : 'Connecter un compte Google',
        },
        variant: 'primary',
        action: {
          kind: 'rpc',
          method: 'antigravity.addAccount',
          params: { providerId },
        },
        onActivate: {
          kind: 'rpc',
          method: 'antigravity.addAccount',
          params: { providerId },
        },
      },
      {
        type: 'stack',
        direction: 'column',
        gap: 'xs',
        children: [
          {
            type: 'text',
            text: { en: 'Multi-Account Routing Strategy', fr: 'Stratégie de routage multi-comptes' },
            className: 'font-semibold text-text-primary text-sm mt-2',
          },
          {
            type: 'select',
            id: 'routingStrategy',
            options: [
              { value: 'fill-first', label: { en: 'Fill First (Priority order — primary handles all requests)', fr: 'Fill First (Ordre de priorité — compte principal en premier)' } },
              { value: 'round-robin', label: { en: 'Round Robin (Cycles through all accounts with sticky limit)', fr: 'Round Robin (Cycle sur tous les comptes)' } },
              { value: 'p2c', label: { en: 'P2C (Power of Two Choices — routes to healthier)', fr: 'P2C (Power of Two Choices — route vers le plus sain)' } },
              { value: 'random', label: { en: 'Random (Randomly selects an account with Fisher-Yates)', fr: 'Random (Sélection aléatoire)' } },
              { value: 'least-used', label: { en: 'Least Used (Routes to account with oldest last usage)', fr: 'Least Used (Compte au dernier usage le plus ancien)' } },
              { value: 'cost-optimized', label: { en: 'Cost Optimized (Routes to lowest cost/priority)', fr: 'Cost Optimized (Coût/priorité le plus bas)' } },
            ],
            defaultValue: settings.routingStrategy || 'fill-first',
            onChange: {
              kind: 'rpc',
              method: 'antigravity.setRoutingStrategy',
            },
          },
          {
            type: 'text',
            text: { en: 'Round Robin Sticky Limit (requests per account)', fr: 'Limite Sticky Round Robin (requêtes consécutives)' },
            muted: true,
            className: 'text-xs text-text-muted mt-1',
          },
          {
            type: 'input',
            id: 'roundRobinStickyLimit',
            inputType: 'number',
            defaultValue: String(settings.roundRobinStickyLimit || 3),
            onChange: {
              kind: 'rpc',
              method: 'antigravity.setStickyLimit',
            },
          },
        ],
      },
    ],
  }
}
