import { DraftPage } from "../../../components/drafts.jsx";
export const metadata = { title: "drafts" };
export default async function Page({ params }) {
  const { id } = await params;
  return <DraftPage id={id} />;
}
