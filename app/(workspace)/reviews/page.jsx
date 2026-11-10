import { Reviews } from "../../components/reviews.jsx";
export const metadata = { title: "Review queue" };
export default async function Page({ searchParams }) {
  const q = await searchParams;
  return <Reviews recordId={q.record_id} />;
}
