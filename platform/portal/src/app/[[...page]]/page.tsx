import { Portal } from '../../portal';
export const dynamic = 'force-dynamic';
export default async function Page({ params }: { params: Promise<{ page?: string[] }> }) {
  const { page } = await params;
  return <Portal page={page?.join('/') ?? ''} />;
}
