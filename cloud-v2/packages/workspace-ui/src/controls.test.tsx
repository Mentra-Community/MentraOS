import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { act, useState, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice, Fact, HostedPageButton, Skeleton, StatusBadge } from "./components/licenses/parts";
import { Checkbox } from "./ui/checkbox";
import { Menu } from "./ui/menu";
import { Meter } from "./ui/meter";
import { SidePanel } from "./ui/side-panel";
import { Stepper } from "./ui/stepper";
import { Switch } from "./ui/switch";
import {
  activeElement,
  byText,
  cleanup,
  click,
  find,
  findAll,
  focus,
  pointerDown,
  press,
  render,
  setupDom,
  teardownDom,
  typeInto,
} from "./test-dom";

beforeAll(setupDom);
afterAll(teardownDom);
afterEach(cleanup);

describe("Checkbox and Switch are native inputs", () => {
  test("a Checkbox is an <input type=checkbox> in the tab order, and Space toggles it", async () => {
    const onChange = mock((event: { target: { checked: boolean } }) => event.target.checked);
    await render(<Checkbox aria-label="Choose Dana" onChange={onChange as never} />);
    const input = find<HTMLInputElement>("input");
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("role")).toBeNull();
    expect(input.getAttribute("aria-label")).toBe("Choose Dana");
    expect(input.tabIndex).toBe(0);
    await focus(input);
    await press(input, " ");
    expect(input.checked).toBe(true);
    await press(input, " ");
    expect(input.checked).toBe(false);
    expect(onChange.mock.results.map((result) => result.value)).toEqual([true, false]);
  });

  test("a Switch is a checkbox with role=switch, and Space toggles it", async () => {
    const seen: boolean[] = [];
    await render(<Switch aria-label="Call Unlimited" defaultChecked onChange={(event) => seen.push(event.target.checked)} />);
    const input = find<HTMLInputElement>("input");
    expect(input.type).toBe("checkbox");
    expect(input.getAttribute("role")).toBe("switch");
    expect(input.checked).toBe(true);
    await press(input, " ");
    await press(input, " ");
    expect(seen).toEqual([false, true]);
  });

  test("a controlled one shows what it is given and asks to change", async () => {
    function Controlled() {
      const [on, setOn] = useState(false);
      return <Switch aria-label="License" checked={on} onChange={(event) => setOn(event.target.checked)} />;
    }
    await render(<Controlled />);
    const input = find<HTMLInputElement>("input");
    await click(input);
    expect(input.checked).toBe(true);
    await click(input);
    expect(input.checked).toBe(false);
  });

  test("a disabled one doesn't toggle and is skipped by the keyboard", async () => {
    const onChange = mock(() => {});
    await render(
      <>
        <Checkbox aria-label="A" disabled onChange={onChange} />
        <Switch aria-label="B" disabled onChange={onChange} />
      </>,
    );
    for (const input of findAll<HTMLInputElement>("input")) {
      expect(input.disabled).toBe(true);
      await click(input);
      expect(input.checked).toBe(false);
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  test("given a label, the whole label is the click target and the checkbox's name", async () => {
    const seen: boolean[] = [];
    await render(<Checkbox label="Luis Ortega" onChange={(event) => seen.push(event.target.checked)} />);
    const label = find<HTMLLabelElement>("label");
    const input = find<HTMLInputElement>("input");
    expect(label.contains(input)).toBe(true);
    expect(label.textContent).toBe("Luis Ortega");
    // At least 24px tall, so the label is a target a thumb can hit.
    expect(label.className).toMatch(/\bmin-h-6\b/);
    await click(byText("Luis Ortega", "span"));
    expect(input.checked).toBe(true);
    await click(label);
    expect(input.checked).toBe(false);
    expect(seen).toEqual([true, false]);
  });

  test("a labelled Checkbox that is disabled can't be toggled from its label either", async () => {
    await render(<Checkbox label="Hannah Kim" disabled />);
    await click(find("label"));
    expect(find<HTMLInputElement>("input").checked).toBe(false);
  });

  test("the text beside one toggles it, when it is in a label", async () => {
    await render(
      <label>
        <Checkbox />
        Luis Ortega
      </label>,
    );
    await click(find("label"));
    expect(find<HTMLInputElement>("input").checked).toBe(true);
  });

  test("the box and the track draw from the tokens, with no fixed colours", () => {
    const markup = renderToStaticMarkup(
      <>
        <Checkbox />
        <Switch />
      </>,
    );
    expect(markup).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(markup).toContain("appearance-none");
  });
});

describe("Meter", () => {
  const widths = (markup: string) => [...markup.matchAll(/width:([\d.]+)%/g)].map((match) => Number(match[1]));

  test("fills to the share in use, hidden from assistive technology (the text beside it says the same)", () => {
    const markup = renderToStaticMarkup(<Meter used={3} total={5} />);
    expect(markup).toContain('aria-hidden="true"');
    expect(widths(markup)).toEqual([60]);
    expect(markup).not.toContain("error-foreground");
  });

  test("past the quantity, the covered part stays dark and the licenses past it are amber", () => {
    const markup = renderToStaticMarkup(<Meter used={10} total={8} />);
    expect(widths(markup)).toEqual([80]);
    expect(markup).toContain("bg-error-foreground");
  });

  test("an empty license is an empty bar, not a division by zero", () => {
    expect(widths(renderToStaticMarkup(<Meter used={0} total={0} />))).toEqual([0]);
  });
});

describe("Stepper", () => {
  function Seats(props: { min?: number; max?: number; start?: number; onChange?: (n: number) => void }) {
    const [n, setN] = useState(props.start ?? 5);
    return (
      <Stepper
        label="Licenses"
        decrementLabel="One license fewer"
        incrementLabel="One license more"
        min={props.min}
        max={props.max}
        value={n}
        onChange={(next) => {
          props.onChange?.(next);
          setN(next);
        }}
      />
    );
  }
  const field = () => find<HTMLInputElement>('input[aria-label="Licenses"]');
  const fewer = () => find<HTMLButtonElement>('button[aria-label="One license fewer"]');
  const more = () => find<HTMLButtonElement>('button[aria-label="One license more"]');

  test("shows − n + and moves one at a time", async () => {
    await render(<Seats />);
    expect(field().value).toBe("5");
    await click(more());
    await click(more());
    await click(fewer());
    expect(field().value).toBe("6");
  });

  test("stops at its bounds: the buttons are disabled and nothing is asked for past them", async () => {
    const onChange = mock((_n: number) => {});
    await render(<Seats min={2} max={4} start={3} onChange={onChange} />);
    await click(more());
    expect(field().value).toBe("4");
    expect(more().disabled).toBe(true);
    await click(more());
    await click(fewer());
    await click(fewer());
    expect(field().value).toBe("2");
    expect(fewer().disabled).toBe(true);
    await click(fewer());
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([4, 3, 2]);
  });

  test("has no upper bound without a maximum", async () => {
    await render(<Seats start={999} />);
    await click(more());
    expect(field().value).toBe("1000");
    expect(more().disabled).toBe(false);
  });

  test("the arrow keys step it, within the bounds, and it reads as a spinbutton", async () => {
    await render(<Seats min={1} max={3} start={2} />);
    const input = field();
    expect(input.getAttribute("role")).toBe("spinbutton");
    expect([input.getAttribute("aria-valuemin"), input.getAttribute("aria-valuemax"), input.getAttribute("aria-valuenow")]).toEqual(["1", "3", "2"]);
    await press(input, "ArrowUp");
    await press(input, "ArrowUp");
    expect(input.value).toBe("3");
    await press(input, "ArrowDown");
    await press(input, "ArrowDown");
    await press(input, "ArrowDown");
    expect(input.value).toBe("1");
  });

  test("a typed number is taken when they leave the field or press Enter, and is held to the bounds", async () => {
    const onChange = mock((_n: number) => {});
    await render(<Seats min={1} max={50} start={5} onChange={onChange} />);
    const input = field();
    await focus(input);
    await typeInto(input, "12");
    expect(onChange).not.toHaveBeenCalled();
    await press(input, "Enter");
    expect(input.value).toBe("12");
    await typeInto(input, "900");
    await act(async () => input.blur());
    expect(input.value).toBe("50");
    await typeInto(input, "0");
    await press(input, "Enter");
    expect(input.value).toBe("1");
    expect(onChange.mock.calls.map((call) => call[0])).toEqual([12, 50, 1]);
  });

  test("something that isn't a number goes back to the last count", async () => {
    await render(<Seats start={5} />);
    const input = field();
    await focus(input);
    await typeInto(input, "");
    await press(input, "Enter");
    expect(input.value).toBe("5");
    await typeInto(input, "ab");
    expect(input.value).toBe("");
    await act(async () => input.blur());
    expect(input.value).toBe("5");
  });

  test("a stepper is never a submit button inside a form", async () => {
    await render(
      <form>
        <Seats />
      </form>,
    );
    expect(fewer().type).toBe("button");
    expect(more().type).toBe("button");
  });
});

describe("Menu", () => {
  const items = (onSelect: (key: string) => void = () => {}) => [
    { key: "change", label: "Change license count", onSelect: () => onSelect("change") },
    { key: "cancel", label: "Cancel", onSelect: () => onSelect("cancel") },
    { key: "locked", label: "Locked", disabled: true, onSelect: () => onSelect("locked") },
    { key: "other", label: "Pause billing", onSelect: () => onSelect("other") },
  ];
  const trigger = () => find<HTMLButtonElement>('button[aria-haspopup="menu"]');
  const menuItems = () => findAll<HTMLButtonElement>('[role="menuitem"]');

  async function mountMenu(onSelect?: (key: string) => void) {
    await render(
      <div>
        <Menu label="More for Mentra Call" trigger="…" items={items(onSelect)} />
        <button type="button">elsewhere</button>
      </div>,
    );
  }

  test("is a button that names itself, collapsed until opened", async () => {
    await mountMenu();
    expect(trigger().getAttribute("aria-label")).toBe("More for Mentra Call");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(findAll('[role="menu"]')).toHaveLength(0);
  });

  test("opens with Enter and puts focus on the first item", async () => {
    await mountMenu();
    await focus(trigger());
    await press(trigger(), "Enter");
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(menuItems().map((item) => item.textContent)).toEqual(["Change license count", "Cancel", "Locked", "Pause billing"]);
    expect(activeElement()).toBe(menuItems()[0]!);
  });

  test("ArrowDown on the closed button opens it too, and ArrowUp opens it on the last item", async () => {
    await mountMenu();
    await focus(trigger());
    await press(trigger(), "ArrowDown");
    expect(activeElement()).toBe(menuItems()[0]!);
    await press(menuItems()[0]!, "Escape");
    await press(trigger(), "ArrowUp");
    expect(activeElement()).toBe(menuItems().at(-1)!);
  });

  test("the arrow keys move between items, skip a disabled one, wrap, and Home and End jump", async () => {
    await mountMenu();
    await focus(trigger());
    await press(trigger(), "Enter");
    const [change, cancel, , other] = menuItems();
    await press(activeElement()!, "ArrowDown");
    expect(activeElement()).toBe(cancel!);
    await press(activeElement()!, "ArrowDown");
    expect(activeElement()).toBe(other!);
    await press(activeElement()!, "ArrowDown");
    expect(activeElement()).toBe(change!);
    await press(activeElement()!, "ArrowUp");
    expect(activeElement()).toBe(other!);
    await press(activeElement()!, "Home");
    expect(activeElement()).toBe(change!);
    await press(activeElement()!, "End");
    expect(activeElement()).toBe(other!);
  });

  test("Escape closes it and gives focus back to the button", async () => {
    await mountMenu();
    await focus(trigger());
    await press(trigger(), "Enter");
    await press(activeElement()!, "Escape");
    expect(findAll('[role="menu"]')).toHaveLength(0);
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(activeElement()).toBe(trigger());
  });

  test("an outside click closes it", async () => {
    await mountMenu();
    await click(trigger());
    expect(findAll('[role="menu"]')).toHaveLength(1);
    await pointerDown(byText("elsewhere", "button"));
    expect(findAll('[role="menu"]')).toHaveLength(0);
  });

  test("a click inside doesn't close it before the item is chosen", async () => {
    await mountMenu();
    await click(trigger());
    await pointerDown(menuItems()[0]!);
    expect(findAll('[role="menu"]')).toHaveLength(1);
  });

  test("choosing an item runs it once, closes the menu and returns focus", async () => {
    const chosen: string[] = [];
    await mountMenu((key) => chosen.push(key));
    await focus(trigger());
    await press(trigger(), "Enter");
    await press(activeElement()!, "ArrowDown");
    await press(activeElement()!, "Enter");
    expect(chosen).toEqual(["cancel"]);
    expect(findAll('[role="menu"]')).toHaveLength(0);
    expect(activeElement()).toBe(trigger());
  });

  test("a disabled item can't be chosen", async () => {
    const chosen: string[] = [];
    await mountMenu((key) => chosen.push(key));
    await click(trigger());
    expect(byText<HTMLButtonElement>("Locked", '[role="menuitem"]').disabled).toBe(true);
    await click(byText("Locked", '[role="menuitem"]'));
    expect(chosen).toEqual([]);
  });

  test("Tab closes it and leaves focus to move on", async () => {
    await mountMenu();
    await click(trigger());
    expect(await press(activeElement()!, "Tab")).toBe(false);
    expect(findAll('[role="menu"]')).toHaveLength(0);
  });

  test("a menu in a panel doesn't let Escape close the panel too", async () => {
    const onClose = mock(() => {});
    await render(
      <SidePanel open onClose={onClose} title="Luis Ortega">
        <Menu label="Change role" trigger="Change role" variant="secondary" size="sm" items={items()} />
      </SidePanel>,
    );
    await click(byText("Change role", "button"));
    expect(findAll('[role="menu"]')).toHaveLength(1);
    await press(activeElement()!, "Escape");
    expect(findAll('[role="menu"]')).toHaveLength(0);
    expect(onClose).not.toHaveBeenCalled();
    await press(byText("Change role", "button"), "Escape");
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("SidePanel", () => {
  function Host(props: { onClosed?: () => void; startOpen?: boolean }) {
    const [open, setOpen] = useState(props.startOpen ?? false);
    return (
      <div>
        <button type="button" onClick={() => setOpen(true)}>
          Open panel
        </button>
        <SidePanel
          open={open}
          onClose={() => {
            props.onClosed?.();
            setOpen(false);
          }}
          title="Luis Ortega"
          description="luis.ortega@example.com"
        >
          <button type="button">First action</button>
          <input aria-label="Notes" />
          <button type="button">Last action</button>
        </SidePanel>
      </div>
    );
  }
  const dialog = () => find<HTMLDialogElement>("dialog");

  test("is a modal dialog named by its title and described by its description", async () => {
    await render(<Host startOpen />);
    expect(dialog().open).toBe(true);
    const labelledBy = dialog().getAttribute("aria-labelledby")!;
    expect(find(`#${CSS.escape(labelledBy)}`).textContent).toBe("Luis Ortega");
    const describedBy = dialog().getAttribute("aria-describedby")!;
    expect(find(`#${CSS.escape(describedBy)}`).textContent).toBe("luis.ortega@example.com");
  });

  test("draws nothing but the shell while closed, so what is inside starts fresh each time", async () => {
    await render(<Host />);
    expect(dialog().open).toBe(false);
    expect(findAll("button", dialog())).toHaveLength(0);
  });

  test("opening puts focus inside it", async () => {
    await render(<Host />);
    const opener = byText("Open panel", "button");
    await focus(opener);
    await click(opener);
    expect(dialog().open).toBe(true);
    expect(dialog().contains(activeElement())).toBe(true);
  });

  test("traps focus: Tab from the last control goes to the first, and Shift+Tab from the first goes to the last", async () => {
    await render(<Host startOpen />);
    const controls = findAll<HTMLElement>("button, input", dialog());
    const first = controls[0]!;
    const last = controls.at(-1)!;
    expect(first.getAttribute("aria-label")).toBe("Close");
    await focus(last);
    expect(await press(last, "Tab")).toBe(true);
    expect(activeElement()).toBe(first);
    expect(await press(first, "Tab", { shift: true })).toBe(true);
    expect(activeElement()).toBe(last);
  });

  test("Tab between its controls is left to the browser", async () => {
    await render(<Host startOpen />);
    const middle = find<HTMLInputElement>("input", dialog());
    await focus(middle);
    expect(await press(middle, "Tab")).toBe(false);
  });

  test("closes on Escape, and focus returns to what opened it", async () => {
    const onClosed = mock(() => {});
    await render(<Host onClosed={onClosed} />);
    const opener = byText("Open panel", "button");
    await focus(opener);
    await click(opener);
    await press(find("input", dialog()), "Escape");
    expect(onClosed).toHaveBeenCalledTimes(1);
    expect(dialog().open).toBe(false);
    expect(activeElement()).toBe(opener);
  });

  test("closes from its × and from a click on the backdrop, once each", async () => {
    const onClosed = mock(() => {});
    await render(<Host startOpen onClosed={onClosed} />);
    await click(find('button[aria-label="Close"]', dialog()));
    expect(onClosed).toHaveBeenCalledTimes(1);
    await click(byText("Open panel", "button"));
    await click(dialog());
    expect(onClosed).toHaveBeenCalledTimes(2);
  });

  test("a click inside it is not a click on the backdrop", async () => {
    const onClosed = mock(() => {});
    await render(<Host startOpen onClosed={onClosed} />);
    await click(byText("First action", "button"));
    expect(onClosed).not.toHaveBeenCalled();
  });

  test("the browser's own cancel (a close request) is handed to the host, which decides", async () => {
    const onClosed = mock(() => {});
    await render(<Host startOpen onClosed={onClosed} />);
    const cancel = new Event("cancel", { cancelable: true });
    await act(async () => void dialog().dispatchEvent(cancel));
    expect(cancel.defaultPrevented).toBe(true);
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("Escape inside a dialog opened from the panel closes that one, not the panel", async () => {
    const onClosed = mock(() => {});
    await render(
      <SidePanel open onClose={onClosed} title="Luis Ortega">
        <dialog open>
          <button type="button">Confirm</button>
        </dialog>
      </SidePanel>,
    );
    await press(byText("Confirm", "button"), "Escape");
    expect(onClosed).not.toHaveBeenCalled();
  });

  // Whatever follows the last reachable control must not be taken for the end of the tab order.
  const UNREACHABLE: Array<[string, ReactNode]> = [
    ["a control with tabindex -1 (a menu's items)", <button type="button" tabIndex={-1}>Only by script</button>],
    ["a control in a disabled fieldset", <fieldset disabled><button type="button">In a fieldset</button></fieldset>],
    ["a control in hidden content", <div hidden><button type="button">Hidden</button></div>],
    ["a control in inert content", <div inert><button type="button">Inert</button></div>],
    ["a control in aria-hidden content", <div aria-hidden="true"><button type="button">Decoration</button></div>],
  ];

  for (const [name, trailing] of UNREACHABLE) {
    test(`Tab wraps at the last control a person can reach, not at ${name}`, async () => {
      await render(
        <SidePanel open onClose={() => {}} title="Luis Ortega">
          <button type="button">First action</button>
          <button type="button">Last action</button>
          {trailing}
        </SidePanel>,
      );
      const last = byText("Last action", "button");
      await focus(last);
      expect(await press(last, "Tab")).toBe(true);
      expect(activeElement()).toBe(find<HTMLElement>('button[aria-label="Close"]'));
      await press(activeElement()!, "Tab", { shift: true });
      expect(activeElement()).toBe(last);
    });
  }

  test("Escape calls onClose once, even when the browser also sends its own cancel for the same press", async () => {
    const onClosed = mock(() => {});
    await render(
      <SidePanel open onClose={onClosed} title="Luis Ortega">
        <input aria-label="Notes" />
      </SidePanel>,
    );
    await act(async () => {
      const input = find("input", dialog());
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      // A browser that doesn't honour the cancelled keydown sends the close request as well.
      dialog().dispatchEvent(new Event("cancel", { cancelable: true }));
    });
    expect(onClosed).toHaveBeenCalledTimes(1);
  });

  test("and a later Escape asks again, for a host that stayed open to ask the person first", async () => {
    const onClosed = mock(() => {});
    await render(
      <SidePanel open onClose={onClosed} title="Luis Ortega">
        <input aria-label="Notes" />
      </SidePanel>,
    );
    await press(find("input", dialog()), "Escape");
    await act(async () => void (await new Promise((resolve) => setTimeout(resolve, 20))));
    await press(find("input", dialog()), "Escape");
    expect(onClosed).toHaveBeenCalledTimes(2);
  });

  test("is full-screen on a phone and a right-hand sheet from the small breakpoint", () => {
    const markup = renderToStaticMarkup(
      <SidePanel open onClose={() => {}} title="Luis Ortega">
        body
      </SidePanel>,
    );
    expect(markup).toMatch(/class="[^"]*\bw-full\b/);
    expect(markup).toMatch(/class="[^"]*\bh-dvh\b/);
    expect(markup).toMatch(/class="[^"]*\bsm:max-w-/);
    expect(markup).toMatch(/class="[^"]*\bml-auto\b/);
  });
});

describe("the licenses' small pieces", () => {
  test("a Notice is a status in every tone: nothing on these pages interrupts the person, so none is an alert", () => {
    const warn = renderToStaticMarkup(
      <Notice tone="warn" title="Licenses stop working on Nov 23, 2026 unless payment goes through." action={<button>Update payment method</button>}>
        Update the payment method to keep them.
      </Notice>,
    );
    expect(warn).toContain('role="status"');
    expect(warn).not.toContain('role="alert"');
    expect(warn).toContain("bg-error");
    expect(warn).toContain("Update the payment method to keep them.");
    expect(renderToStaticMarkup(<Notice tone="info" title="Payment received" />)).toContain('role="status"');
    expect(renderToStaticMarkup(<Notice tone="neutral" title="Nothing yet" />)).toContain('role="status"');
  });

  test("a Notice's buttons wrap on a row of their own on a phone instead of running out of the notice", () => {
    const markup = renderToStaticMarkup(
      <Notice tone="warn" title="Licenses stop working" action={<><button>Update payment method</button><button>Complete payment</button></>} />,
    );
    const actions = /<div class="([^"]*)"><button>Update payment method/.exec(markup)?.[1] ?? "";
    expect(actions).toContain("flex-wrap");
    expect(actions).toContain("max-sm:basis-full");
    // Not unshrinkable on a phone: that is what pushed the second button out of the notice.
    expect(actions).not.toMatch(/(^| )shrink-0/);
  });

  test("a Fact is a term and its values, with a foot", () => {
    const markup = renderToStaticMarkup(<Fact label="Cost" value="$145 a month" foot="5 × $29 · before tax" />);
    expect(markup).toMatch(/<dt[^>]*>Cost<\/dt>/);
    expect(markup).toMatch(/<dd[^>]*>\$145 a month<\/dd>/);
    expect(markup).toContain("5 × $29 · before tax");
  });

  test("Facts sit validly in a <dl>: a div per group, holding only the term and its descriptions", async () => {
    await render(
      <dl>
        <Fact label="Licenses" value="3 of 5 assigned" foot="2 available">
          <Meter used={3} total={5} />
        </Fact>
        <Fact label="Renews" value="Nov 20, 2026" foot="Every month" />
        <Fact label="Cost" value="$145 a month" />
      </dl>,
    );
    const list = find("dl");
    const groups = [...list.children];
    expect(groups.map((group) => group.tagName)).toEqual(["DIV", "DIV", "DIV"]);
    for (const group of groups) {
      expect([...group.children].every((child) => child.tagName === "DT" || child.tagName === "DD")).toBe(true);
      expect(findAll("dt", group)).toHaveLength(1);
      // The term comes first, then its descriptions.
      expect(group.children[0]!.tagName).toBe("DT");
    }
    expect([...groups[0]!.children].map((child) => child.tagName)).toEqual(["DT", "DD", "DD", "DD"]);
    expect([...groups[1]!.children].map((child) => child.tagName)).toEqual(["DT", "DD", "DD"]);
    expect([...groups[2]!.children].map((child) => child.tagName)).toEqual(["DT", "DD"]);
    // The meter sits in a description of its own, and what each says is in its place.
    expect(groups[0]!.children[1]!.textContent).toBe("3 of 5 assigned");
    expect(find("[data-slot=meter]", groups[0]!.children[2]!)).toBeDefined();
    expect(groups[0]!.children[3]!.textContent).toBe("2 available");
  });

  test("a Skeleton is a placeholder with no text", () => {
    expect(renderToStaticMarkup(<Skeleton className="w-16" />)).toMatch(/<span[^>]*w-16[^>]*><\/span>/);
  });

  test("a StatusBadge is a chip in its tone, with a spinner while something is setting up", () => {
    const setting = renderToStaticMarkup(<StatusBadge status={{ label: "Setting up", tone: "neutral", spin: true }} />);
    expect(setting).toContain("Setting up");
    expect(setting).toContain("animate-spin");
    const failed = renderToStaticMarkup(<StatusBadge status={{ label: "Payment failed", tone: "warn" }} />);
    expect(failed).toContain("bg-error");
    expect(failed).not.toContain("animate-spin");
  });

  test("a HostedPageButton is a button marked ↗, named by its label alone", async () => {
    const onClick = mock(() => {});
    await render(<HostedPageButton onClick={onClick}>Add licenses</HostedPageButton>);
    const button = find<HTMLButtonElement>("button");
    expect(button.textContent).toBe("Add licenses");
    expect(button.hasAttribute("data-hosted-page")).toBe(true);
    expect(find("svg", button).getAttribute("aria-hidden")).toBe("true");
    expect(button.type).toBe("button");
    await click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  test("a HostedPageButton tells a screen reader it leaves the portal, in visually hidden text it is described by", async () => {
    await render(<HostedPageButton>Add licenses</HostedPageButton>);
    const button = find<HTMLButtonElement>("button");
    const hint = find(`#${CSS.escape(button.getAttribute("aria-describedby")!)}`);
    expect(hint.textContent).toBe("Opens a secure billing page");
    expect(hint.className).toContain("sr-only");
    // The name stays the label: only the description carries the cue.
    expect(button.textContent).toBe("Add licenses");
    expect(button.contains(hint)).toBe(false);
  });

  test("and, for a hosted page that opens in a new tab, says so", async () => {
    await render(<HostedPageButton newTab>Complete payment</HostedPageButton>);
    const button = find<HTMLButtonElement>("button");
    expect(find(`#${CSS.escape(button.getAttribute("aria-describedby")!)}`).textContent).toBe(
      "Opens a secure billing page in a new tab",
    );
  });

  test("two HostedPageButtons describe themselves by two different hints", async () => {
    await render(
      <>
        <HostedPageButton>Add licenses</HostedPageButton>
        <HostedPageButton>Cancel</HostedPageButton>
      </>,
    );
    const ids = findAll<HTMLButtonElement>("button").map((button) => button.getAttribute("aria-describedby"));
    expect(new Set(ids).size).toBe(2);
  });

  test("a HostedPageButton that is waiting for its session shows a spinner and can't be pressed again", async () => {
    const onClick = mock(() => {});
    await render(
      <HostedPageButton pending onClick={onClick}>
        Add licenses
      </HostedPageButton>,
    );
    const button = find<HTMLButtonElement>("button");
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    expect(find(".animate-spin", button)).toBeDefined();
  });
});
