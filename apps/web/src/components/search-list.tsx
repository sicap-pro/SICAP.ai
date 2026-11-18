import { headers } from "next/headers";
import { after } from "next/server";
import { auth } from "@/lib/auth";
import { listRequestId, recordAccountRead, requestIp } from "@/lib/account-read";
import { formatNumber } from "@/utils";
import { isQueryLengthOk, lastValue, parsePage, parsePerPage } from "@/utils/params";
import type { IndexName } from "@sicap/api";
import { searchContracts } from "@sicap/api";

import { ListItem } from "./list-item";
import { Pagination } from "./pagination";
import { PerPage } from "./per-page";
import { FilterDetails } from "./filter-details";
import { CSVDownload } from "./csv-download";

export interface SearchParams {
  q: string;
  p: number;
  perPage: number;
  db: string;
  dateFrom: string;
  dateTo: string;
  valueFrom: string;
  valueTo: string;
  authority: string;
  cpv: string;
  localityAuthority: string;
  countyAuthority: string;
  supplier: string;
  localitySupplier: string;
  countySupplier: string;
  isFiscal?: string;
  euFunds?: string;
}

interface SearchListProps {
  searchParams: SearchParams;
}

export async function SearchList({ searchParams }: SearchListProps) {
  const query = lastValue(searchParams.q) ?? "";
  const page = parsePage(searchParams.p);
  const perPage = parsePerPage(searchParams.perPage);
  const db = searchParams.db as string | string[] | undefined;
  const dateFrom = lastValue(searchParams.dateFrom);
  const dateTo = lastValue(searchParams.dateTo);
  const valueFrom = lastValue(searchParams.valueFrom);
  const valueTo = lastValue(searchParams.valueTo);
  const authority = lastValue(searchParams.authority);
  const cpv = lastValue(searchParams.cpv);
  const localityAuthority = lastValue(searchParams.localityAuthority);
  const countyAuthority = lastValue(searchParams.countyAuthority);
  const supplier = lastValue(searchParams.supplier);
  const localitySupplier = lastValue(searchParams.localitySupplier);
  const countySupplier = lastValue(searchParams.countySupplier);
  const euFunds = lastValue(searchParams.euFunds);

  const filters = {
    // Index selection is normalized inside searchContracts.
    db: (db === undefined ? undefined : Array.isArray(db) ? db : [db]) as IndexName[] | undefined,
    dateFrom,
    dateTo,
    cpv,
    valueFrom,
    valueTo,
    authority,
    localityAuthority,
    countyAuthority,
    supplier,
    localitySupplier,
    countySupplier,
    euFunds: euFunds === "true",
  };

  const results = isQueryLengthOk(query)
    ? await searchContracts({ query, page, perPage, filters })
    : { items: [], total: 0 };

  const rowCount = results.items.length;
  if (rowCount > 0) {
    try {
      const reqHeaders = await headers();
      const session = await auth.api.getSession({ headers: reqHeaders });
      if (session?.user?.id) {
        const userId = session.user.id;
        const ip = requestIp(reqHeaders);
        const id = listRequestId({ query, filters, page, perPage });
        after(() =>
          recordAccountRead({ userId, kind: "list", id, n: rowCount, via: "search", ip }),
        );
      }
    } catch {
      // usage logging must never break the page
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h3 className="text-sm">
        Pagina {page} din {formatNumber(results.total)} rezultate pentru <b>{query}</b>
      </h3>
      <div className="flex items-center gap-4 justify-between">
        <FilterDetails searchParams={searchParams} />
        <div className="flex gap-2">
          <CSVDownload items={results.items} />
          <PerPage total={perPage} />
        </div>
      </div>
      <div className="flex flex-col gap-4">
        {results.items.map((item) => (
          <ListItem key={item.id!} fields={item.fields} id={item.id!} index={item.index} />
        ))}
      </div>
      <Pagination
        page={page}
        hasPreviousPage={page > 1}
        hasNextPage={page * perPage < results.total}
      />
    </div>
  );
}
