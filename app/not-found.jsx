import Link from "next/link";
export default function NotFound() {
  return (
    <main className="boot">
      <section className="panel narrow">
        <h1>Page not found</h1>
        <p>
          This page does not exist. Return to your workspace to find a record.
        </p>
        <Link className="button primary" href="/records">
          Browse records
        </Link>
      </section>
    </main>
  );
}
