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
  isAuthenticating?: boolean,
): DeclarativeNode {
  const accountCards: DeclarativeNode[] = accounts.map((acc, idx) => {
    const actionButtons: DeclarativeNode[] = []

    if (accounts.length > 1) {
      actionButtons.push(
        {
          type: 'button',
          label: { en: '↑', fr: '↑' },
          title: { en: 'Move Up (Higher Priority)', fr: 'Monter (Priorité supérieure)' },
          variant: 'ghost',
          disabled: idx === 0,
          action: {
            kind: 'rpc',
            method: 'antigravity.reorderAccount',
            params: { credentialRef: acc.credentialRef, providerId, direction: 'up' },
          },
          onActivate: {
            kind: 'rpc',
            method: 'antigravity.reorderAccount',
            params: { credentialRef: acc.credentialRef, providerId, direction: 'up' },
          },
        },
        {
          type: 'button',
          label: { en: '↓', fr: '↓' },
          title: { en: 'Move Down (Lower Priority)', fr: 'Descendre (Priorité inférieure)' },
          variant: 'ghost',
          disabled: idx === accounts.length - 1,
          action: {
            kind: 'rpc',
            method: 'antigravity.reorderAccount',
            params: { credentialRef: acc.credentialRef, providerId, direction: 'down' },
          },
          onActivate: {
            kind: 'rpc',
            method: 'antigravity.reorderAccount',
            params: { credentialRef: acc.credentialRef, providerId, direction: 'down' },
          },
        },
      )
    }

    actionButtons.push({
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
    })

    return {
      type: 'card',
      className: 'w-full',
      children: [
        {
          type: 'stack',
          direction: 'row',
          align: 'center',
          justify: 'between',
          className: 'w-full',
          children: [
            {
              type: 'stack',
              direction: 'row',
              align: 'center',
              gap: 'sm',
              className: 'flex-1 min-w-0',
              children: [
                {
                  type: 'badge',
                  label: { en: `#${idx + 1}`, fr: `#${idx + 1}` },
                  tone: idx === 0 ? 'info' : 'neutral',
                },
                {
                  type: 'stack',
                  direction: 'column',
                  gap: 'none',
                  className: 'min-w-0',
                  children: [
                    {
                      type: 'text',
                      text: { en: acc.email || `Google Account ${idx + 1}`, fr: acc.email || `Compte Google ${idx + 1}` },
                      className: 'font-semibold text-text-primary text-sm truncate',
                    },
                    {
                      type: 'text',
                      text: {
                        en: acc.status === 'connected' ? 'Connected ✓' : 'Disconnected / Expired',
                        fr: acc.status === 'connected' ? 'Connecté ✓' : 'Déconnecté / Expiré',
                      },
                      className:
                        acc.status === 'connected'
                          ? 'text-xs text-accent-success font-medium'
                          : 'text-xs text-text-muted',
                    },
                  ],
                },
              ],
            },
            {
              type: 'stack',
              direction: 'row',
              align: 'center',
              justify: 'end',
              gap: 'xs',
              className: 'shrink-0 ml-auto',
              children: actionButtons,
            },
          ],
        },
      ],
    }
  })

  const children: DeclarativeNode[] = [
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
  ]

  if (isAuthenticating) {
    children.push({
      type: 'callout',
      tone: 'warning',
      title: {
        en: 'Connecting Google Account...',
        fr: 'Connexion au compte Google en cours...',
      },
      text: {
        en: 'A browser window was opened for Google authorization. Please complete the sign-in prompt to add your account.',
        fr: 'Une fenêtre de navigateur a été ouverte pour l\'autorisation Google. Veuillez compléter la connexion pour ajouter votre compte.',
      },
    })
  }

  children.push(
    {
      type: 'stack',
      direction: 'column',
      gap: 'sm',
      align: 'stretch',
      className: 'w-full',
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
    isAuthenticating
      ? {
          type: 'button',
          label: {
            en: '⏳ Connecting...',
            fr: '⏳ Connexion en cours...',
          },
          variant: 'primary',
          disabled: true,
        }
      : {
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
      align: 'stretch',
      className: 'w-full',
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
            {
              value: 'fill-first',
              label: {
                en: 'Fill First (Priority order — primary handles all requests)',
                fr: 'Fill First (Ordre de priorité — compte principal en premier)',
              },
            },
            {
              value: 'round-robin',
              label: {
                en: 'Round Robin (Cycles through all accounts with sticky limit)',
                fr: 'Round Robin (Cycle sur tous les comptes)',
              },
            },
            {
              value: 'p2c',
              label: {
                en: 'P2C (Power of Two Choices — routes to healthier)',
                fr: 'P2C (Power of Two Choices — route vers le plus sain)',
              },
            },
            {
              value: 'random',
              label: {
                en: 'Random (Randomly selects an account with Fisher-Yates)',
                fr: 'Random (Sélection aléatoire)',
              },
            },
            {
              value: 'least-used',
              label: {
                en: 'Least Used (Routes to account with oldest last usage)',
                fr: 'Least Used (Compte au dernier usage le plus ancien)',
              },
            },
            {
              value: 'cost-optimized',
              label: {
                en: 'Cost Optimized (Routes to lowest cost/priority)',
                fr: 'Cost Optimized (Coût/priorité le plus bas)',
              },
            },
          ],
          defaultValue: settings.routingStrategy || 'fill-first',
          onChange: {
            kind: 'rpc',
            method: 'antigravity.setRoutingStrategy',
          },
        },
        {
          type: 'text',
          text: {
            en: 'Round Robin Sticky Limit (requests per account)',
            fr: 'Limite Sticky Round Robin (requêtes consécutives)',
          },
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
  )

  return {
    type: 'stack',
    direction: 'column',
    gap: 'md',
    align: 'stretch',
    className: 'w-full',
    children,
  }
}
