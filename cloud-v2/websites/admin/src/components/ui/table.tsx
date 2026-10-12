import type {ComponentProps} from "react";
import {cn} from "../../lib/utils";

function Table({className, ...props}: ComponentProps<"table">) {
  return <div data-slot="table-container" className="relative w-full overflow-x-auto">
    <table data-slot="table" className={cn("w-full caption-bottom text-sm", className)} {...props}/>
  </div>;
}

function TableHeader({className, ...props}: ComponentProps<"thead">) {
  return <thead data-slot="table-header" className={cn("[&_tr]:border-b", className)} {...props}/>;
}

function TableBody({className, ...props}: ComponentProps<"tbody">) {
  return <tbody data-slot="table-body" className={cn("[&_tr:last-child]:border-0", className)} {...props}/>;
}

function TableRow({className, ...props}: ComponentProps<"tr">) {
  return <tr data-slot="table-row" className={cn("border-b border-[#d0d7de] transition-colors hover:bg-[#f6f8fa]", className)} {...props}/>;
}

function TableHead({className, ...props}: ComponentProps<"th">) {
  return <th data-slot="table-head" scope="col" className={cn("h-10 px-4 text-left align-middle font-medium text-[#656d76]", className)} {...props}/>;
}

function TableCell({className, ...props}: ComponentProps<"td">) {
  return <td data-slot="table-cell" className={cn("px-4 py-3 align-top", className)} {...props}/>;
}

export {Table, TableHeader, TableBody, TableRow, TableHead, TableCell};
