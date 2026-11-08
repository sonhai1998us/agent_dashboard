import NewTicketForm from './NewTicketForm';

/** ?dir=… (nút + cạnh project ở cột trái): điền sẵn thư mục dự án. */
export default async function Page({ searchParams }: { searchParams: Promise<{ dir?: string | string[] }> }) {
  const { dir } = await searchParams;
  return <NewTicketForm initialDir={typeof dir === 'string' ? dir : ''} />;
}
