#!/bin/bash
for f in $*; do
  echo $f
  grep -v '<hdop>[0-9.]*.*hdop>' $f|sed -E 's/(<ele>[0-9]*)([.][0-9]*)/\1/'|sed 's/\r$//' > $f.opt
  mv $f.opt $f
done
