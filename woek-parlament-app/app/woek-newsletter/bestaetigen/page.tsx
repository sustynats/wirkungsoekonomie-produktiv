import { Suspense } from "react";
import NewsletterAction from "../components/NewsletterAction";

export default function NewsletterPage() {
  return (
    <Suspense fallback={<p role="status">Wirkungsbrief wird geladen …</p>}>
      <NewsletterAction action="confirm" />
    </Suspense>
  );
}
