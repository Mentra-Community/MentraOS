import type {ReactNode} from 'react';
import clsx from 'clsx';
import Heading from '@theme/Heading';
import styles from './styles.module.css';

type FeatureItem = {
  title: string;
  description: ReactNode;
};

const FeatureList: FeatureItem[] = [
  {
    title: 'Build Smart Glasses Apps',
    description: (
      <>
        Create immersive, real-time applications for smart glasses 
        with our comprehensive SDK and development tools.
      </>
    ),
  },
  {
    title: 'Real-Time User Interaction',
    description: (
      <>
        Leverage speech recognition, head gestures, and contextual 
        information to build natural user experiences.
      </>
    ),
  },
  {
    title: 'Open Source Community',
    description: (
      <>
        Join our growing ecosystem of developers building the future
        of wearable computing on an open platform.
      </>
    ),
  },
];

function Feature({title, description}: FeatureItem) {
  return (
    <div className={clsx('col col--4')}>
      <div className="text--center padding-horiz--md">
        <Heading as="h3">{title}</Heading>
        <p>{description}</p>
      </div>
    </div>
  );
}

export default function HomepageFeatures(): ReactNode {
  return (
    <section className={styles.features}>
      <div className="container">
        <div className="row">
          {FeatureList.map((props, idx) => (
            <Feature key={idx} {...props} />
          ))}
        </div>
      </div>
    </section>
  );
}
