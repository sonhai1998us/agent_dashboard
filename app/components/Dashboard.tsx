'use client';
import TopBar from './TopBar';
import SessionList from './SessionList';
import styles from './Dashboard.module.css';

export default function Dashboard() {
  return (
    <div className={styles.shell}>
      <TopBar />
      <main className={styles.grid}>
        <SessionList />
        {/* TODO(task 9): cây agent + timeline (cột giữa) */}
        <section className={styles.panel} aria-label="Cây agent và timeline">
          <div className={styles.ph}>Cây agent + timeline — sẽ có ở bước sau</div>
        </section>
        {/* TODO(task 10): chi tiết agent trực tiếp (cột phải) */}
        <aside className={styles.panel} aria-label="Chi tiết agent">
          <div className={styles.ph}>Chi tiết agent — sẽ có ở bước sau</div>
        </aside>
      </main>
    </div>
  );
}
