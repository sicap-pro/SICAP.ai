import { ImageResponse } from "next/og";
import type { NextRequest } from "next/server";

import { baseUrl } from "@/config/site";
import { GENERIC_OG_TITLE, isLegacyToken, verifyToken } from "@/utils/og";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ slug: string[] }> },
) {
  const { searchParams } = new URL(request.url);
  const resolvedParams = await params;
  const [first, second] = resolvedParams.slug;
  const requestedTitle = searchParams.getAll("title").at(-1) ?? "";

  const id = second ? first : first?.split("/")[0];
  const token = second ? second : first?.split("/")[1];

  const tokenValue = token ?? "";
  let title: string;
  if (id && verifyToken(id, requestedTitle, tokenValue)) {
    title = requestedTitle;
  } else if (id && isLegacyToken(id, tokenValue)) {
    title = GENERIC_OG_TITLE;
  } else {
    return new Response("Invalid token.", { status: 401 });
  }

  return new ImageResponse(
    <div
      style={{
        height: "100%",
        width: "100%",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: "white",
      }}
    >
      <div tw="flex flex-col bg-gray-50 p-16">
        {/* biome-ignore lint/a11y/useAltText: OG image generation requires img element */}
        {/* biome-ignore lint/performance/noImgElement: next/image cannot be used in OG image generation */}
        <img
          width="96"
          height="96"
          src={`${baseUrl}/windows11/Square44x44Logo.altform-unplated_targetsize-96.png`}
        />
        <div tw="flex flex-col w-full">
          <h1 tw="text-xl sm:text-2xl font-bold text-left">{title}</h1>
        </div>
      </div>
    </div>,
    {
      width: 1200,
      height: 630,
      headers: {
        "Cache-Control": "public, max-age=86400, s-maxage=604800, stale-while-revalidate=86400",
      },
    },
  );
}
