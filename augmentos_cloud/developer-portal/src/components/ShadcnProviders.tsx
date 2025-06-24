// // components/ShadcnProviders.tsx
// import React from 'react';

// // Import shadcn/ui provider components
// import {
//   TooltipProvider
// } from "@/components/ui/tooltip";


// // Theme provider if you're using themes
// // import {
// //   ThemeProvider
// // } from "@/components/ui/theme-provider";

// interface ShadcnProvidersProps {
//   children: React.ReactNode;
// }

// /**
//  * A component that wraps all necessary shadcn/ui providers
//  * Use this at the root of your application to ensure all components
//  * have access to the context they need
//  */
// export function ShadcnProviders({ children }: ShadcnProvidersProps) {
//   // Note: Some providers might not be needed based on your shadcn/ui implementation
//   // Comment out any that aren't required or cause errors

//   // You may need to adjust the nesting order based on your specific requirements
//   return (
//     // <ThemeProvider defaultTheme="light" storageKey="mentraos-theme">
//       <TooltipProvider>
//         <ToastProvider>
//           <DialogProvider>
//             <PopoverProvider>
//               <DropdownMenuProvider>
//                 <CommandProvider>
//                   {children}
//                 </CommandProvider>
//               </DropdownMenuProvider>
//             </PopoverProvider>
//           </DialogProvider>
//         </ToastProvider>
//       </TooltipProvider>
//     // </ThemeProvider>
//   );
// }

// export default ShadcnProviders;