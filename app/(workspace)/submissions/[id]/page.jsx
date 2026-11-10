import { SubmissionDetails } from "../../../components/activity.jsx";
export const metadata = { title: "submissions" };
export default async function Page({ params }) {
  const { id } = await params;
  return <SubmissionDetails id={id} />;
}
