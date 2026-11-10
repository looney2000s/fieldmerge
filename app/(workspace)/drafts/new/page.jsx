import { NewDraft } from "../../../components/drafts.jsx";
export const metadata = { title: "Create draft" };
export default async function Page({ searchParams }) {
  const q = await searchParams;
  return <NewDraft recordId={q.record_id} version={q.version} />;
}
