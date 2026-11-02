'use client';
import TopBar from './TopBar';
import SessionList from './SessionList';
import AgentTimeline from './AgentTimeline';
import AgentDetail from './AgentDetail';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  return (
    <div className={styles.shell}>
      <TopBar />
      <main className={styles.grid}>
        <SessionList />
        <AgentTimeline />
        <AgentDetail />
      </main>
    </div>
  );
}
