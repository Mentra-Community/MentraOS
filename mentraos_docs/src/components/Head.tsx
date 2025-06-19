import React from 'react';
import Head from '@docusaurus/Head';
import useBaseUrl from '@docusaurus/useBaseUrl';

export default function SEOHead() {
  const imageUrl = useBaseUrl('img/augmentos-social-card.png', {absolute: true});
  
  return (
    <Head>
      {/* Open Graph / Facebook */}
      <meta property="og:type" content="website" />
      <meta property="og:title" content="AugmentOS Developer Documentation" />
      <meta property="og:description" content="Build applications for the open-source operating system for smart glasses" />
      <meta property="og:image" content={imageUrl} />

      {/* Twitter */}
      <meta name="twitter:card" content="summary_large_image" />
      <meta name="twitter:title" content="AugmentOS Developer Documentation" />
      <meta name="twitter:description" content="Build applications for the open-source operating system for smart glasses" /> 
      <meta name="twitter:image" content={imageUrl} />
    </Head>
  );
}