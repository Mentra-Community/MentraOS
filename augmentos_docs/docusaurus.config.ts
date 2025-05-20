import { themes as prismThemes } from 'prism-react-renderer';
import type { Config } from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

// This runs in Node.js - Don't use client-side code here (browser APIs, JSX...)

const config: Config = {
  title: 'AugmentOS SDK Docs (Beta)',
  tagline: 'Build your AugmentOS smart glasses app.',
  favicon: 'img/favicon.ico',

  // Set the production url of your site here
  url: 'https://docs.augmentos.org',
  // Set the /<baseUrl>/ pathname under which your site is served
  // For GitHub pages deployment, it is often '/<projectName>/'
  baseUrl: '/',

  // GitHub pages deployment config.
  // If you aren't using GitHub pages, you don't need these.
  organizationName: 'augmentos-community', // Usually your GitHub org/user name.
  projectName: 'augmentos', // Usually your repo name.

  onBrokenLinks: 'warn',
  onBrokenMarkdownLinks: 'warn',

  // Even if you don't use internationalization, you can use this field to set
  // useful metadata like html lang. For example, if your site is Chinese, you
  // may want to replace "en" with "zh-Hans".
  i18n: {
    defaultLocale: 'en',
    locales: ['en'],
  },

  presets: [
    [
      'classic',
      {
        docs: {
          sidebarPath: './sidebars.ts',
          // Please change this to your repo.
          // Remove or update this to remove/edit "edit this page" links.
          editUrl:
            'https://github.com/augmentos-community/augmentos/tree/main/augmentos_docs/create-docusaurus/',
          routeBasePath: '/', // Set docs as the root
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  markdown: {
    mermaid: true,
  },
  themes: ['@docusaurus/theme-mermaid'],

  themeConfig: {
    // Social card for link previews
    image: 'img/augmentos-social-card.png',
    metadata: [
      {name: 'og:image', content: 'https://docs.augmentos.org/img/augmentos-social-card.png'},
      {name: 'twitter:image', content: 'https://docs.augmentos.org/img/augmentos-social-card.png'},
      {name: 'twitter:card', content: 'summary_large_image'},
    ],
    navbar: {
      title: 'AugmentOS SDK Docs (Beta)',
      logo: {
        alt: 'AugmentOS Logo',
        src: 'img/logo.svg',
      },
      // Only docs in the navbar
      items: [
        {
          href: 'https://github.com/augmentos-community/augmentos',
          label: 'GitHub',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Home',
              to: '/',
            },
            {
              label: 'Quickstart',
              to: '/quickstart',
            },
            {
              label: '🚧 Build From Scratch',
              to: '/getting-started',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'Discord',
              href: 'https://discord.gg/5ukNvkEAqT',
            },
            {
              label: 'X',
              href: 'https://x.com/mentra',
            },
          ],
        },
        {
          title: 'More',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/augmentos-community/augmentos',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} AugmentOS Community. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
