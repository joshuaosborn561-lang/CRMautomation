import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "CRM Autopilot",
  description: "AI-powered CRM pipeline assistant",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body
        style={{
          margin: 0,
          fontFamily:
            '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          backgroundColor: "#ffffff",
          color: "#1a1a1a",
          minHeight: "100vh",
        }}
      >
        {children}
      </body>
    </html>
  );
}
