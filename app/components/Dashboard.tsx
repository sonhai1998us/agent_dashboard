'use client';
import TopBar from './TopBar';
import TicketList from './TicketList';
import SessionList from './SessionList';
import AgentTimeline from './AgentTimeline';
import AgentDetail from './AgentDetail';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  return (
    <div className={styles.shell}>
      <TopBar />
      <main className={styles.grid}>
        <div className={styles.left}>
          <TicketList />
          <SessionList />
        </div>
        <AgentTimeline />
        <AgentDetail />
      </main>
    </div>
  );
}
