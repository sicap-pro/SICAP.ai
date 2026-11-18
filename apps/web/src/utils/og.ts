import { createHmac, timingSafeEqual } from "node:crypto";

import { baseUrl } from "@/config/site";
import { env } from "@/lib/env";

const OG_SECRET = env.OG_SECRET;

export const GENERIC_OG_TITLE = "SICAP.ai - achizitii publice";

const sign = (payload: { id: string; title?: string }, secret: string): string =>
  createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");

const safeEqualHex = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
};

export const getToken = (id: string, title: string, secret: string = OG_SECRET): string =>
  sign({ id, title }, secret);

export const verifyToken = (
  id: string,
  title: string,
  token: string,
  secret: string = OG_SECRET,
): boolean => safeEqualHex(token, getToken(id, title, secret));

/** Tokens issued before titles were signed cover only the id. */
export const isLegacyToken = (id: string, token: string, secret: string = OG_SECRET): boolean =>
  safeEqualHex(token, sign({ id }, secret));

export const getOgImageUrl = (id: string, title: string): string =>
  `${baseUrl}/og/${id}/${getToken(id, title)}/?title=${encodeURIComponent(title)}`;

interface OpenGraphProps {
  id: string;
  title: string;
  description: string;
  path: string;
}

export function generateOpenGraph({ id, title, description, path }: OpenGraphProps) {
  return {
    openGraph: {
      title,
      description,
      url: `${baseUrl}${path}`,
      images: [
        {
          url: getOgImageUrl(id, title),
          width: 1200,
          height: 630,
        },
      ],
      locale: "en_RO",
      type: "website",
    },
  };
}
