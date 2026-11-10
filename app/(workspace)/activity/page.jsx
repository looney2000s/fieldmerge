import { Activity } from "../../components/activity.jsx";
export const metadata = { title: "Submissions" };
export default async function Page({ searchParams }) {
  const q = await searchParams;
  return <Activity recordId={q.record_id} />;
}
