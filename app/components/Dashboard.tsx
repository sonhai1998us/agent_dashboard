'use client';
import { useEffect } from 'react';
import { selectTicket } from '../lib/liveStore';
import TopBar from './TopBar';
import TicketList from './TicketList';
import SessionList from './SessionList';
import AgentTimeline from './AgentTimeline';
import TicketHeader from './TicketHeader';
import AgentDetail from './AgentDetail';
import UserActionDialog from './UserActionDialog';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('ticket');
    if (id) selectTicket(id);
  }, []);
  return (
    <div className={styles.shell}>
      <TopBar />
      <main className={styles.grid}>
        <div className={styles.left}>
          <TicketList />
          <SessionList />
        </div>
        <div className={styles.mid}>
          <TicketHeader />
          <AgentTimeline />
        </div>
        <AgentDetail />
      </main>
      <UserActionDialog />
    </div>
  );
}
