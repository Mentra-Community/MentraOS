import {FunctionComponent, PropsWithChildren} from "react"

type WrapperComponent = FunctionComponent<{children: React.ReactNode}>

export function withWrappers(...wrappers: Array<WrapperComponent>) {
  return function (props: PropsWithChildren) {
    return wrappers.reduceRight((acc, Wrapper) => {
      return <Wrapper>{acc}</Wrapper>
    }, props.children)
  }
}
