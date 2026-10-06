import { XMLParser } from "fast-xml-parser";

/** Attributes become `@`-prefixed keys; repeated child elements become arrays */
export type PropValue = string | PropValue[] | { [name: string]: PropValue };

export type DavResponse = {
  href: string;
  props: Record<string, PropValue>;
};

type RawPropstat = {
  prop: Record<string, PropValue>;
  status: string;
};

type RawResponse = {
  href: string;
  propstat: RawPropstat[];
};

const OK_STATUS = / 200 /;
const ARRAY_PATHS = new Set([
  "multistatus.response",
  "multistatus.response.propstat",
]);

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreDeclaration: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  parseTagValue: false,
  htmlEntities: true,
  isArray: (_name, jpath) => ARRAY_PATHS.has(String(jpath)),
});

export function parseMultistatus(xml: string): DavResponse[] {
  const document: { multistatus: { response?: RawResponse[] } } =
    parser.parse(xml);
  return (document.multistatus.response ?? []).map((response) => ({
    href: response.href,
    props: Object.assign(
      {},
      ...response.propstat
        .filter((propstat) => OK_STATUS.test(propstat.status))
        .map((propstat) => propstat.prop),
    ),
  }));
}
