"use client";

import { useState, useEffect } from "react";

const STORAGE_KEY = "cmdb_page_size";
const VALID_SIZES = [10, 25, 50, 100, 250] as const;
export type PageSize = typeof VALID_SIZES[number];
export const PAGE_SIZE_OPTIONS = VALID_SIZES;
const DEFAULT_PAGE_SIZE: PageSize = 25;

function clamp(v: number): PageSize {
  return (VALID_SIZES.includes(v as PageSize) ? v : DEFAULT_PAGE_SIZE) as PageSize;
}

export function usePageSize() {
  const [pageSize, setPageSizeState] = useState<PageSize>(DEFAULT_PAGE_SIZE);

  useEffect(() => {
    const stored = parseInt(localStorage.getItem(STORAGE_KEY) ?? "", 10);
    if (!isNaN(stored)) setPageSizeState(clamp(stored));
  }, []);

  function setPageSize(size: PageSize) {
    setPageSizeState(size);
    localStorage.setItem(STORAGE_KEY, String(size));
  }

  return { pageSize, setPageSize };
}
