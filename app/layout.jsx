import "./globals.css";
import { SessionProvider } from "./components/session.jsx";
export const metadata = {
  title: { default: "FieldMerge", template: "%s · FieldMerge" },
  description: "Traceable reconciliation for delayed field surveys",
};
export default function Layout({ children }) {
  return (
    <html lang="en">
      <body>
        <SessionProvider>{children}</SessionProvider>
      </body>
    </html>
  );
}
