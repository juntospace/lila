import React from "react";
import { BoardReportSkeleton } from "./components/BoardSkeleton";

export default function PortfolioBoardLoading() {
  return (
    <div className="min-h-screen bg-bg-surface p-6 lg:p-10">
      <BoardReportSkeleton />
    </div>
  );
}

