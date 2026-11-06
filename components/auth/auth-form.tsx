"use client";

import { CircleAlert, CircleCheck, Eye, EyeOff } from "lucide-react";
import { type ComponentProps, useActionState, useState } from "react";
import type { AuthFormState } from "@/app/auth/actions";
import { SubmitButton } from "@/components/shared/submit-button";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { Field, Input } from "@/components/ui/form-controls";

type FieldName = "email" | "password" | "confirmPassword";

const FIELDS: Record<FieldName, { label: string; type: string; autoComplete: string }> = {
  email: { label: "Email", type: "email", autoComplete: "email" },
  password: { label: "Password", type: "password", autoComplete: "current-password" },
  confirmPassword: { label: "Confirm password", type: "password", autoComplete: "new-password" },
};

/**
 * Shared form for sign-in, registration and password reset. All validation and authentication happens in the
 * server action; this component only renders its state. Passwords are never kept in client state.
 */
export function AuthForm({
  action,
  fields,
  submitLabel,
  pendingLabel,
  next,
  newPassword,
}: {
  action: (state: AuthFormState, formData: FormData) => Promise<AuthFormState>;
  fields: FieldName[];
  submitLabel: string;
  pendingLabel: string;
  next?: string;
  /** Use "new-password" autocomplete for the password field (registration, reset). */
  newPassword?: boolean;
}) {
  const [state, formAction] = useActionState(action, { status: "idle", message: "" } satisfies AuthFormState);
  const errors = state.fieldErrors ?? {};

  return (
    <form action={formAction} className="grid gap-4" noValidate>
      {state.status === "error" && state.message ? (
        <Alert variant="destructive">
          <CircleAlert />
          <AlertTitle>{state.message}</AlertTitle>
        </Alert>
      ) : null}
      {state.status === "success" ? (
        <Alert variant="success">
          <CircleCheck />
          <AlertTitle>{state.message}</AlertTitle>
        </Alert>
      ) : null}
      {next ? <input type="hidden" name="next" value={next} /> : null}
      {fields.map((name) => {
        const f = FIELDS[name];
        const autoComplete = name === "password" && newPassword ? "new-password" : f.autoComplete;
        return (
          <Field key={name} id={`auth-${name}`} label={f.label} required error={errors[name]}>
            {f.type === "password" ? (
              <PasswordInput id={`auth-${name}`} name={name} autoComplete={autoComplete} required maxLength={72} aria-invalid={errors[name] ? true : undefined} />
            ) : (
              <Input id={`auth-${name}`} name={name} type={f.type} autoComplete={autoComplete} required maxLength={name === "email" ? 254 : 72} aria-invalid={errors[name] ? true : undefined} />
            )}
          </Field>
        );
      })}
      <SubmitButton pendingLabel={pendingLabel}>{submitLabel}</SubmitButton>
    </form>
  );
}

/** Password input with a show/hide toggle. Only the visibility flag is kept in state, never the password. */
function PasswordInput(props: Omit<ComponentProps<"input">, "type">) {
  const [visible, setVisible] = useState(false);
  const Icon = visible ? EyeOff : Eye;
  return (
    <div className="relative">
      <Input {...props} type={visible ? "text" : "password"} className="pr-10" />
      <button
        type="button"
        onClick={() => setVisible((v) => !v)}
        aria-label={visible ? "Hide password" : "Show password"}
        aria-controls={props.id}
        aria-pressed={visible}
        className="absolute inset-y-0 right-0 grid w-10 place-content-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-ring"
      >
        <Icon className="size-4" aria-hidden />
      </button>
    </div>
  );
}
