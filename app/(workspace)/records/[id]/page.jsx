import { RecordDetails } from "../../../components/records.jsx";
export const metadata = { title: "records" };
export default async function Page({ params }) {
  const { id } = await params;
  return <RecordDetails id={id} />;
}
