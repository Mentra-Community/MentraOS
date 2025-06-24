import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

/**
 * Creating a sidebar enables you to:
 - create an ordered group of docs
 - render a sidebar for each doc of that group
 - provide next/previous navigation

 The sidebars can be generated from the filesystem, or explicitly defined here.

 Create as many sidebars as you want.
 */
const sidebars: SidebarsConfig = {
  // Manually defined sidebar structure
  tutorialSidebar: [
    'index',
    {
      type: 'category',
      label: 'Getting Started',
      link: {
        type: 'doc',
        id: 'quickstart',
      },
      items: [
        {
          type: 'doc',
          id: 'getting-started',
          label: 'Build From Scratch',
        },
        {
          type: 'doc',
          id: 'voice-activation',
          label: 'Voice Activation Tutorial',
        },
        {
          type: 'doc',
          id: 'railway-deployment',
          label: 'Deploy to Railway',
        },
        {
          type: 'doc',
          id: 'ubuntu-deployment',
          label: 'Deploy to Ubuntu Server',
        }
      ],
    },
    {
      type: 'category',
      label: 'Core Concepts',
      link: {
        type: 'doc',
        id: 'core-concepts',
      },
      items: [
        {
          type: 'doc',
          id: 'tpa-lifecycle',
          label: 'App Lifecycle',
        },
        'events',
        'permissions',
        'layouts',
        'settings',
        'tools',
        'capabilities',
        'webview-auth-overview',
        'react-webviews',
        'dashboard'
      ],
    },
    {
      type: 'category',
      label: 'SDK Reference',
      link: {
        type: 'doc',
        id: 'reference/index',
      },
      items: [
        'reference/tpa-server',
        'reference/tpa-session',
        {
          type: 'category',
          label: 'Managers',
          items: [
            'reference/managers/event-manager',
            'reference/managers/layout-manager',
            'reference/managers/settings-manager',
          ],
        },
        'reference/enums',
        {
          type: 'category',
          label: 'Interfaces',
          items: [
            'reference/interfaces/config-types',
            'reference/interfaces/event-types',
            'reference/interfaces/layout-types',
            'reference/interfaces/capabilities',
            'reference/interfaces/webhook-types',
            'reference/interfaces/message-types',
            'reference/interfaces/tool-types',
            'reference/interfaces/setting-types',
          ],
        },
        'reference/dashboard-api',
        'reference/utilities',
      ],
    },
    {
      type: 'doc',
      id: 'contributing',
      label: '👥 Contributing Guide',
    },
  ],
};

export default sidebars;
