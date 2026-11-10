import { BatchDetails } from "../../../components/batches.jsx";
export const metadata = { title: "batches" };
export default async function Page({ params }) {
  const { id } = await params;
  return <BatchDetails id={id} />;
}
