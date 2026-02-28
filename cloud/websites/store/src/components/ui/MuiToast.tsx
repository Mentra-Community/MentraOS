import React, { createContext, useContext, useState, useCallback } from "react";
import { Snackbar, Alert, AlertColor } from "@mui/material";
import { useTheme } from "../../hooks/useTheme";

interface Toast {
  id: string;
  message: string;
  type: AlertColor;
}

interface ToastContextType {
  showToast: (message: string, type: AlertColor) => void;
}

const ToastContext = createContext<ToastContextType | undefined>(undefined);

export const useToast = () => {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
};

export const ToastProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { theme } = useTheme();
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [isMobile, setIsMobile] = useState(false);

  // Detect mobile on mount and resize
  React.useEffect(() => {
    const checkMobile = () => {
      setIsMobile(window.innerWidth < 640);
    };
    checkMobile();
    window.addEventListener("resize", checkMobile);
    return () => window.removeEventListener("resize", checkMobile);
  }, []);

  const showToast = useCallback((message: string, type: AlertColor) => {
    const id = Math.random().toString(36).substr(2, 9);
    setToasts((prev) => [...prev, { id, message, type }]);
  }, []);

  const handleClose = (id: string) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
  };

  return (
    <ToastContext.Provider value={{ showToast }}>
      {children}
      {toasts.map((toast, index) => (
        <Snackbar
          key={toast.id}
          open={true}
          autoHideDuration={4000}
          onClose={() => handleClose(toast.id)}
          anchorOrigin={{
            vertical: isMobile ? "bottom" : "top",
            horizontal: isMobile ? "center" : "right",
          }}
          sx={{
            zIndex: 999999,
            ...(isMobile
              ? {
                  bottom: `${16 + index * 70}px !important`,
                  left: "0 !important",
                  right: "0 !important",
                  transform: "none !important",
                }
              : {
                  marginTop: `${index * 70}px`,
                }),
          }}>
          <Alert
            onClose={() => handleClose(toast.id)}
            severity={toast.type}
            variant="filled"
            sx={{
              "width": isMobile ? "calc(100vw - 32px)" : "auto",
              "minWidth": isMobile ? "unset" : "320px",
              "maxWidth": isMobile ? "calc(100vw - 32px)" : "450px",
              "margin": isMobile ? "0 16px" : "0",
              "fontFamily": '"Red Hat Display", sans-serif',
              "fontSize": "14px",
              "fontWeight": 500,
              "borderRadius": isMobile ? "12px" : "16px",
              "padding": "9.5px 16px",
              "boxShadow": theme === "light" ? "0 4px 12px rgba(0, 0, 0, 0.15)" : "0 4px 12px rgba(0, 0, 0, 0.4)",
              "backdropFilter": "blur(12px)",
              "WebkitBackdropFilter": "blur(12px)",
              "& .MuiAlert-icon": {
                fontSize: "22px",
                alignSelf: "center",
              },
              "& .MuiAlert-message": {
                padding: "0",
                flex: 1,
                textAlign: isMobile ? "center" : "left",
                display: "flex",
                alignItems: "center",
              },
              "& .MuiAlert-action": {
                padding: "0 0 0 8px",
                marginRight: "-4px",
                alignSelf: "center",
              },
              // Success styling with transparent background and green text
              ...(toast.type === "success" && {
                "backgroundColor": theme === "light" ? "rgba(255, 255, 255, 0.85)" : "rgba(23, 23, 23, 0.85)",
                "color": "#00A814",
                "& .MuiAlert-icon": {
                  color: "#00A814",
                },
              }),
              // Error styling with transparent background and red text
              ...(toast.type === "error" && {
                "backgroundColor": theme === "light" ? "rgba(255, 255, 255, 0.85)" : "rgba(23, 23, 23, 0.85)",
                "color": theme === "light" ? "rgba(239, 68, 68, 1)" : "rgba(220, 38, 38, 1)",
                "& .MuiAlert-icon": {
                  color: theme === "light" ? "rgba(239, 68, 68, 1)" : "rgba(220, 38, 38, 1)",
                },
              }),
              // Info styling with transparent background and blue text
              ...(toast.type === "info" && {
                "backgroundColor": theme === "light" ? "rgba(255, 255, 255, 0.85)" : "rgba(23, 23, 23, 0.85)",
                "color": theme === "light" ? "rgba(59, 130, 246, 1)" : "rgba(37, 99, 235, 1)",
                "& .MuiAlert-icon": {
                  color: theme === "light" ? "rgba(59, 130, 246, 1)" : "rgba(37, 99, 235, 1)",
                },
              }),
              // Warning styling with transparent background and amber text
              ...(toast.type === "warning" && {
                "backgroundColor": theme === "light" ? "rgba(255, 255, 255, 0.85)" : "rgba(23, 23, 23, 0.85)",
                "color": theme === "light" ? "rgba(245, 158, 11, 1)" : "rgba(217, 119, 6, 1)",
                "& .MuiAlert-icon": {
                  color: theme === "light" ? "rgba(245, 158, 11, 1)" : "rgba(217, 119, 6, 1)",
                },
              }),
            }}>
            {toast.message}
          </Alert>
        </Snackbar>
      ))}
    </ToastContext.Provider>
  );
};

// Helper functions for easy usage
export const toast = {
  success: (message: string) => {
    // This will be called from components using useToast hook
    return { message, type: "success" as AlertColor };
  },
  error: (message: string) => {
    return { message, type: "error" as AlertColor };
  },
  info: (message: string) => {
    return { message, type: "info" as AlertColor };
  },
  warning: (message: string) => {
    return { message, type: "warning" as AlertColor };
  },
};
