import { cn } from "../lib/utils.js";
import { LoaderCircle } from "lucide-react";
import { useCodezIntl } from "@/i18n/IntlProvider.js";

function Spinner({ className, ...props }: React.ComponentProps<"svg">) {
  const { intl } = useCodezIntl();
  return (
    <LoaderCircle
      role="status"
      aria-label={intl.formatMessage({ id: "common.loading" })}
      className={cn("size-4 animate-spin", className)}
      {...props}
    />
  );
}

export { Spinner };
