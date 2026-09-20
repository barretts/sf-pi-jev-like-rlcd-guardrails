import {
  summarizeContact,
  type Contact,
  type ContactSummary,
} from "../src/contact.js";

type Equal<Left, Right> =
  (<T>() => T extends Left ? 1 : 2) extends <T>() => T extends Right ? 1 : 2
    ? true
    : false;
type Assert<Condition extends true> = Condition;

type ContactShape = Assert<
  Equal<
    Contact,
    {
      displayName: string | null;
      email: string | null;
    }
  >
>;
type SummaryShape = Assert<
  Equal<
    ContactSummary,
    {
      label: string;
      email: string | null;
    }
  >
>;
type SummaryInput = Assert<
  Equal<Parameters<typeof summarizeContact>, [Contact]>
>;
type SummaryOutput = Assert<
  Equal<ReturnType<typeof summarizeContact>, ContactSummary>
>;

const nullableInput: Contact = { displayName: null, email: null };
const nullableOutput: ContactSummary = summarizeContact(nullableInput);
void nullableOutput;
