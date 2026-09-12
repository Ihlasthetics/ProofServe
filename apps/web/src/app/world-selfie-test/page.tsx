import type { Metadata } from 'next';
import { WorldSelfieTest } from '../../components/world-selfie-test';
import styles from './world-selfie-test.module.css';

export const metadata: Metadata = {
  title: 'World Selfie Check Legacy — ProofServe',
  description: 'Standalone provider verification test for ProofServe.',
};

export default function WorldSelfieTestPage() {
  return (
    <main className={styles.page}>
      <a className={styles.back} href="/">
        ProofServe home
      </a>
      <WorldSelfieTest />
    </main>
  );
}
