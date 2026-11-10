import { RecoveryDetail } from "../../../components/recovery.jsx";
export const metadata = { title: "recovery" };
export default async function Page({ params }) {
  const { id } = await params;
  return <RecoveryDetail id={id} />;
}
