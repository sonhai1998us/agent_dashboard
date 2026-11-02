'use client';
import TopBar from './TopBar';
import SessionList from './SessionList';
import AgentTimeline from './AgentTimeline';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  return (
    <div className={styles.shell}>
      <TopBar />
      <main className={styles.grid}>
        <SessionList />
        <AgentTimeline />
        {/* TODO(task 10): chi tiết agent trực tiếp (cột phải) */}
        <aside className={styles.panel} aria-label="Chi tiết agent">
          <div className={styles.ph}>Chi tiết agent — sẽ có ở bước sau</div>
        </aside>
      </main>
    </div>
  );
}
