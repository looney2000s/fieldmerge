"use client";
export default function ErrorPage({ reset }) {
  return (
    <section className="panel narrow" role="alert">
      <h1>Unable to open this page</h1>
      <p>Try loading the page again.</p>
      <button className="button primary" onClick={reset}>
        Try again
      </button>
    </section>
  );
}
