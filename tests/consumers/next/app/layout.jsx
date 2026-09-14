import "@azelotech/scan/styles.css";

export const metadata = { title: "scan smoke — next" };

export default function RootLayout({ children }) {
  return (
    <html lang="pt-BR">
      <body>{children}</body>
    </html>
  );
}
